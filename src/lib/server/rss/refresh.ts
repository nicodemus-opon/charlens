import { and, asc, desc, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import {
	article,
	articleEmbedding,
	articleEvent,
	collection,
	feed,
	recommendScoreLog,
	subscription,
	userArticleState,
	userFeedback,
	userInterest
} from '$lib/server/db/feeds.schema';
import {
	buildAffinityMaps,
	burstBoosts,
	canonicalTitleKey,
	cosineSimilarity,
	deterministicExploreBoost,
	DEEP_SHUFFLE_EXPLORATION_MULTIPLIER,
	idfWeight,
	injectExplorationSlots,
	interactionWeight,
	keywordMatchBoost,
	normalizedFeedScores,
	rankWithMMR,
	scoreCandidate,
	SESSION_HALF_LIFE_MS,
	SHUFFLE_EXPLORATION_MULTIPLIER,
	tagAffinity,
	timeDecay,
	ENGAGEMENT_HALF_LIFE_MS,
	type AffinityMaps
} from '$lib/server/recommend/score';
import {
	parseStoredStrings,
	parseStoredVector,
	similarityToInterest,
	updateUserInterest
} from '$lib/server/enrich/enrich';
import { articleTag, tag } from '$lib/server/db/tags.schema';
import {
	GENERAL_COLLECTION,
	normalizeCollectionName,
	normalizeSmartRules,
	parseSmartRules,
	validateSmartRules,
	type CollectionKind,
	type CollectionRow,
	type SmartRules
} from '$lib/collections';
import { normalizeFeedTags, normalizeTagName, parseTagInput, type TagRef } from '$lib/tags';
import {
	discoverFeed,
	fetchFeed,
	isTransientFeedError,
	type DiscoverResult
} from '$lib/server/rss/parser';
import { getRsshubBase, isRsshubUrl } from '$lib/server/rss/rsshub';
import { stripDuplicateImage } from '$lib/server/rss/sanitize';
import { backfillTruncatedArticles, isFulltextAutoEnabled } from '$lib/server/rss/fulltext';
import { backfillUnenrichedArticles, isEnrichAutoEnabled } from '$lib/server/enrich/enrich';

export type ArticleFilter = 'today' | 'saved' | 'all' | 'recommended';

export type ArticleEventKind =
	| 'impression'
	| 'open'
	| 'dwell'
	| 'scroll'
	| 'save'
	| 'share'
	| 'finish'
	| 'dismiss'
	| 'mute_feed'
	| 'mute_topic';

const EVENT_KINDS = new Set<string>([
	'impression',
	'open',
	'dwell',
	'scroll',
	'save',
	'share',
	'finish',
	'dismiss',
	'mute_feed',
	'mute_topic'
]);

export type FeedbackKind = 'dismiss' | 'mute_feed' | 'mute_topic';

export function isArticleEventKind(value: unknown): value is ArticleEventKind {
	return typeof value === 'string' && EVENT_KINDS.has(value);
}

/**
 * Fire-and-forget interest-model refresh so a couple of clicks move semantic
 * ranking on the next Recommended load instead of waiting for the 15-minute
 * scheduler tick. Throttled per user (60s) and never blocks event logging —
 * dwell/scroll beacons fire every 15s and must stay cheap.
 */
const interestRefreshAt = new Map<string, number>();
const INTEREST_REFRESH_DEBOUNCE_MS = 60_000;

function scheduleInterestRefresh(userId: string): void {
	const now = Date.now();
	if (now - (interestRefreshAt.get(userId) ?? 0) < INTEREST_REFRESH_DEBOUNCE_MS) return;
	interestRefreshAt.set(userId, now);
	void updateUserInterest(userId).catch((e) => console.error('interest refresh failed', e));
}

/** Test-only: reset the interest-refresh throttle. */
export function _resetInterestRefreshForTests(): void {
	interestRefreshAt.clear();
}

export const STALE_MS = 15 * 60 * 1000;

/** Pure: is this feed due for a refresh? Testable without a DB. */
export function isFeedStale(
	lastFetchedAt: Date | null | undefined,
	force = false,
	now = Date.now()
): boolean {
	if (force) return true;
	if (!lastFetchedAt) return true;
	return now - lastFetchedAt.getTime() > STALE_MS;
}

/**
 * Pure: pin format=rss for RSSHub route URLs so rss-parser gets XML.
 * Rows with source='rsshub' are also re-pinned to the *configured* instance:
 * the stored URL may carry a stale host from another environment (host dev
 * persists http://localhost:1200/..., containers reach http://rsshub:1200).
 */
export function buildFetchUrl(
	feedLike: { url: string; source?: string | null },
	rsshubBase: string = getRsshubBase()
): string {
	const { url, source } = feedLike;
	if (source === 'rsshub' || isRsshubUrl(url)) {
		try {
			const u = new URL(url);
			let changed = false;
			if (source === 'rsshub') {
				const base = new URL(rsshubBase);
				if (u.host.toLowerCase() !== base.host.toLowerCase() || u.protocol !== base.protocol) {
					u.protocol = base.protocol;
					u.host = base.host;
					changed = true;
				}
			}
			if (!u.searchParams.has('format')) {
				u.searchParams.set('format', 'rss');
				changed = true;
			}
			if (changed) return u.toString();
		} catch {
			// keep original URL
		}
	}
	return url;
}

/**
 * True while the row still carries addFeed's placeholder title — the input's
 * hostname — because populateFeed never finished (transient fetch failure,
 * RSSHub outage). Such rows re-run discovery on their next refresh instead of
 * refetching a page that is not a feed.
 */
export function isPlaceholderFeed(f: {
	url: string;
	siteUrl?: string | null;
	title: string | null;
}): boolean {
	if (!f.title) return true;
	if (f.title === f.url || (f.siteUrl && f.title === f.siteUrl)) return true;
	for (const raw of [f.siteUrl, f.url]) {
		if (!raw) continue;
		try {
			if (f.title === new URL(raw).hostname) return true;
		} catch {
			// unparseable stored URL — fall through
		}
	}
	return false;
}

// Feeds/articles are private per user (feed.userId owns everything).
// Organization lives in `collection` (manual groups + smart views); each
// subscription points at one collection. Read/saved state lives in
// userArticleState. Every read path below takes a userId and filters on it.

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

function asKind(value: unknown): CollectionKind {
	return value === 'smart' ? 'smart' : 'manual';
}

export async function ensureCollectionByName(
	userId: string,
	name: string,
	kind: CollectionKind = 'manual'
): Promise<number> {
	const clean = normalizeCollectionName(name) || GENERAL_COLLECTION;
	const existing = await db
		.select({ id: collection.id })
		.from(collection)
		.where(and(eq(collection.userId, userId), eq(collection.name, clean)))
		.limit(1);
	if (existing[0]) return existing[0].id;
	const inserted = await db
		.insert(collection)
		.values({ userId, name: clean, kind })
		.onConflictDoNothing({ target: [collection.userId, collection.name] })
		.returning({ id: collection.id });
	if (inserted[0]) return inserted[0].id;
	const retry = await db
		.select({ id: collection.id })
		.from(collection)
		.where(and(eq(collection.userId, userId), eq(collection.name, clean)))
		.limit(1);
	return retry[0].id;
}

/**
 * Lazy backfill: older rows have subscription.collectionId NULL and only the
 * legacy `category` string. Group those by category, create matching
 * collections, and link them. Idempotent and safe to call on every load.
 */
export async function backfillCollectionsForUser(userId: string) {
	const subs = await db
		.select()
		.from(subscription)
		.where(and(eq(subscription.userId, userId)));
	const needsLink = subs.filter((s) => s.collectionId == null);
	for (const sub of needsLink) {
		const name = normalizeCollectionName(sub.category) || GENERAL_COLLECTION;
		const id = await ensureCollectionByName(userId, name);
		await db
			.update(subscription)
			.set({ collectionId: id, category: name })
			.where(and(eq(subscription.userId, userId), eq(subscription.feedId, sub.feedId)));
	}
}

export async function listCollections(userId: string): Promise<CollectionRow[]> {
	await backfillCollectionsForUser(userId);
	const rows = await db
		.select({
			id: collection.id,
			name: collection.name,
			kind: collection.kind,
			rules: collection.rules,
			position: collection.position,
			feedCount: sql<number>`count(distinct ${feed.id})`.mapWith(Number),
			unread:
				sql<number>`count(distinct ${article.id}) filter (where ${article.id} is not null and coalesce(${userArticleState.isRead}, false) = false)`.mapWith(
					Number
				)
		})
		.from(collection)
		.leftJoin(subscription, eq(subscription.collectionId, collection.id))
		.leftJoin(feed, and(eq(feed.id, subscription.feedId), eq(feed.userId, userId)))
		.leftJoin(article, eq(article.feedId, feed.id))
		.leftJoin(
			userArticleState,
			and(eq(userArticleState.articleId, article.id), eq(userArticleState.userId, userId))
		)
		.where(eq(collection.userId, userId))
		.groupBy(collection.id)
		.orderBy(asc(collection.position), asc(collection.name));
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		kind: asKind(r.kind),
		rules: parseSmartRules(r.rules),
		position: r.position ?? 0,
		feedCount: r.feedCount ?? 0,
		unread: r.unread ?? 0
	}));
}

export async function createCollection(userId: string, name: string): Promise<number> {
	const clean = normalizeCollectionName(name);
	if (!clean) throw new Error('Collection name is required');
	return ensureCollectionByName(userId, clean, 'manual');
}

export async function renameCollection(userId: string, id: number, name: string) {
	const clean = normalizeCollectionName(name);
	if (!clean) throw new Error('Collection name is required');
	await backfillCollectionsForUser(userId);
	await db
		.update(collection)
		.set({ name: clean })
		.where(and(eq(collection.id, id), eq(collection.userId, userId)));
	// Keep the legacy column in sync for rows still grouped by name.
	await db
		.update(subscription)
		.set({ category: clean })
		.where(and(eq(subscription.userId, userId), eq(subscription.collectionId, id)));
}

export async function deleteCollection(userId: string, id: number) {
	await backfillCollectionsForUser(userId);
	const rows = await db
		.select()
		.from(collection)
		.where(and(eq(collection.id, id), eq(collection.userId, userId)))
		.limit(1);
	const target = rows[0];
	if (!target) return;
	if (target.name === GENERAL_COLLECTION)
		throw new Error('The General collection cannot be deleted');
	const fallbackId = await ensureCollectionByName(userId, GENERAL_COLLECTION);
	await db
		.update(subscription)
		.set({ collectionId: fallbackId, category: GENERAL_COLLECTION })
		.where(and(eq(subscription.userId, userId), eq(subscription.collectionId, id)));
	await db.delete(collection).where(and(eq(collection.id, id), eq(collection.userId, userId)));
}

/** Move one of the user's feeds into a (manual) collection. */
export async function moveFeed(userId: string, feedId: number, collectionId: number) {
	await backfillCollectionsForUser(userId);
	const target = await db
		.select()
		.from(collection)
		.where(and(eq(collection.id, collectionId), eq(collection.userId, userId)))
		.limit(1);
	if (!target[0]) throw new Error('Collection not found');
	if (asKind(target[0].kind) !== 'manual') throw new Error('Smart views hold no feeds');
	await db
		.update(subscription)
		.set({ collectionId, category: target[0].name })
		.where(and(eq(subscription.userId, userId), eq(subscription.feedId, feedId)));
}

export async function createSmartCollection(
	userId: string,
	name: string,
	rulesInput: SmartRules
): Promise<number> {
	const clean = normalizeCollectionName(name);
	if (!clean) throw new Error('Smart view name is required');
	const rules = normalizeSmartRules(rulesInput);
	const error = validateSmartRules(rules);
	if (error) throw new Error(error);
	const inserted = await db
		.insert(collection)
		.values({ userId, name: clean, kind: 'smart', rules })
		.onConflictDoNothing({ target: [collection.userId, collection.name] })
		.returning({ id: collection.id });
	if (inserted[0]) return inserted[0].id;
	// Name taken: update the existing row into a smart view instead of failing.
	await db
		.update(collection)
		.set({ kind: 'smart', rules })
		.where(and(eq(collection.userId, userId), eq(collection.name, clean)));
	const existing = await db
		.select({ id: collection.id })
		.from(collection)
		.where(and(eq(collection.userId, userId), eq(collection.name, clean)))
		.limit(1);
	return existing[0].id;
}

export async function updateSmartCollectionRules(
	userId: string,
	id: number,
	rulesInput: SmartRules
) {
	const rules = normalizeSmartRules(rulesInput);
	const error = validateSmartRules(rules);
	if (error) throw new Error(error);
	await db
		.update(collection)
		.set({ kind: 'smart', rules })
		.where(and(eq(collection.id, id), eq(collection.userId, userId)));
}

export async function getSmartRules(
	userId: string,
	collectionId: number
): Promise<SmartRules | null> {
	const rows = await db
		.select({ kind: collection.kind, rules: collection.rules })
		.from(collection)
		.where(and(eq(collection.id, collectionId), eq(collection.userId, userId)))
		.limit(1);
	if (!rows[0] || asKind(rows[0].kind) !== 'smart') return null;
	return parseSmartRules(rows[0].rules);
}

export async function getFeedsWithCounts(userId: string) {
	await backfillCollectionsForUser(userId);
	const rows = await db
		.select({
			id: feed.id,
			url: feed.url,
			title: feed.title,
			siteUrl: feed.siteUrl,
			imageUrl: feed.imageUrl,
			collectionId: collection.id,
			collectionName: collection.name,
			collectionKind: collection.kind,
			// Legacy alias: sidebar/UI historically grouped by `category`.
			category: collection.name,
			unread:
				sql<number>`count(${article.id}) filter (where coalesce(${userArticleState.isRead}, false) = false)`.mapWith(
					Number
				),
			total: sql<number>`count(${article.id})`.mapWith(Number)
		})
		.from(subscription)
		.innerJoin(feed, eq(feed.id, subscription.feedId))
		.leftJoin(collection, eq(collection.id, subscription.collectionId))
		.leftJoin(article, eq(article.feedId, feed.id))
		.leftJoin(
			userArticleState,
			and(eq(userArticleState.articleId, article.id), eq(userArticleState.userId, userId))
		)
		.where(and(eq(subscription.userId, userId), eq(feed.userId, userId)))
		.groupBy(feed.id, collection.id, collection.name, collection.kind)
		.orderBy(feed.title);
	return rows.map((r) => ({
		...r,
		collectionId: r.collectionId ?? null,
		collectionName: r.collectionName ?? GENERAL_COLLECTION,
		collectionKind: asKind(r.collectionKind),
		category: r.category ?? GENERAL_COLLECTION
	}));
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export interface TagWithCount {
	id: number;
	name: string;
	count: number;
}

/** Find-or-create a tag owned by this user. Names are stored lowercase. */
export async function ensureTag(userId: string, name: string): Promise<number | null> {
	const clean = normalizeTagName(name).toLowerCase();
	if (!clean) return null;
	const existing = await db
		.select({ id: tag.id })
		.from(tag)
		.where(and(eq(tag.userId, userId), eq(tag.name, clean)))
		.limit(1);
	if (existing[0]) return existing[0].id;
	const inserted = await db
		.insert(tag)
		.values({ userId, name: clean })
		.onConflictDoNothing({ target: [tag.userId, tag.name] })
		.returning({ id: tag.id });
	if (inserted[0]) return inserted[0].id;
	const retry = await db
		.select({ id: tag.id })
		.from(tag)
		.where(and(eq(tag.userId, userId), eq(tag.name, clean)))
		.limit(1);
	return retry[0]?.id ?? null;
}

/** All tags for a user with per-tag article counts (for the sidebar). */
export async function listTags(userId: string): Promise<TagWithCount[]> {
	const rows = await db
		.select({
			id: tag.id,
			name: tag.name,
			count: sql<number>`count(distinct ${articleTag.articleId})`.mapWith(Number)
		})
		.from(tag)
		.leftJoin(articleTag, eq(articleTag.tagId, tag.id))
		.where(eq(tag.userId, userId))
		.groupBy(tag.id, tag.name)
		.orderBy(asc(tag.name));
	return rows.map((r) => ({ id: r.id, name: r.name, count: r.count ?? 0 }));
}

export async function renameTag(userId: string, id: number, name: string) {
	const clean = normalizeTagName(name).toLowerCase();
	if (!clean) throw new Error('Tag name is required');
	await db
		.update(tag)
		.set({ name: clean })
		.where(and(eq(tag.id, id), eq(tag.userId, userId)));
}

export async function deleteTag(userId: string, id: number) {
	await db.delete(tag).where(and(eq(tag.id, id), eq(tag.userId, userId)));
}

/** Tags attached to one article, with ids for the tag-filter links. */
export async function getArticleTags(userId: string, articleId: number): Promise<TagRef[]> {
	if (!(await canAccessArticle(userId, articleId))) return [];
	const rows = await db
		.select({ id: tag.id, name: tag.name })
		.from(articleTag)
		.innerJoin(tag, and(eq(tag.id, articleTag.tagId), eq(tag.userId, userId)))
		.where(eq(articleTag.articleId, articleId))
		.orderBy(asc(tag.name));
	return rows;
}

/** Map of articleId to tags for a batch (avoids N+1 in list views). */
export async function getTagsForArticles(
	userId: string,
	articleIds: number[]
): Promise<Map<number, TagRef[]>> {
	const out = new Map<number, TagRef[]>();
	const ids = [...new Set(articleIds.filter((n) => Number.isInteger(n)))];
	if (ids.length === 0) return out;
	const rows = await db
		.select({ articleId: articleTag.articleId, id: tag.id, name: tag.name })
		.from(articleTag)
		.innerJoin(tag, and(eq(tag.id, articleTag.tagId), eq(tag.userId, userId)))
		.innerJoin(article, eq(article.id, articleTag.articleId))
		.innerJoin(feed, and(eq(feed.id, article.feedId), eq(feed.userId, userId)))
		.where(inArray(articleTag.articleId, ids))
		.orderBy(asc(tag.name));
	for (const r of rows) {
		const list = out.get(r.articleId) ?? [];
		list.push({ id: r.id, name: r.name });
		out.set(r.articleId, list);
	}
	return out;
}

/** Replace the tag set on an article from a free-form input string. */
export async function setArticleTags(userId: string, articleId: number, input: string) {
	if (!(await canAccessArticle(userId, articleId))) return;
	const names = parseTagInput(input);
	const keepIds: number[] = [];
	for (const name of names) {
		const id = await ensureTag(userId, name);
		if (id) keepIds.push(id);
	}
	await db.delete(articleTag).where(eq(articleTag.articleId, articleId));
	for (const tagId of keepIds) {
		await db
			.insert(articleTag)
			.values({ tagId, articleId, source: 'manual' })
			.onConflictDoNothing({ target: [articleTag.tagId, articleTag.articleId] });
	}
}

/** Translate SmartRules into SQL conditions (ownership still enforced by caller). */
function smartRulesConditions(rules: SmartRules, userId?: string) {
	const preds = [];
	const keywords = (rules.keywords ?? []).map((k) => k.trim()).filter(Boolean);
	for (const kw of keywords) {
		const q = `%${kw}%`;
		preds.push(or(ilike(article.title, q), ilike(article.excerpt, q), ilike(article.author, q))!);
	}
	if (rules.author?.trim()) {
		preds.push(ilike(article.author, `%${rules.author.trim()}%`));
	}
	const feedIds = (rules.feedIds ?? []).filter((n) => Number.isFinite(n));
	if (feedIds.length > 0) preds.push(inArray(article.feedId, feedIds));
	const tagNames = (rules.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
	for (const name of tagNames) {
		preds.push(
			sql`exists (select 1 from ${articleTag} join ${tag} on ${tag.id} = ${articleTag.tagId} where ${articleTag.articleId} = ${article.id} and ${tag.name} = ${name}${userId ? sql` and ${tag.userId} = ${userId}` : sql``})`
		);
	}
	if (rules.savedOnly) preds.push(eq(userArticleState.isSaved, true));
	if (rules.daysBack && rules.daysBack > 0) {
		preds.push(gte(article.publishedAt, new Date(Date.now() - rules.daysBack * 86400000)));
	}
	// unreadOnly can't be expressed without the state join here — the join is
	// always present in getArticles, so express it via the coalesced flag.
	if (rules.unreadOnly) {
		preds.push(sql`coalesce(${userArticleState.isRead}, false) = false`);
	}
	if (preds.length === 0) return undefined;
	return rules.match === 'any' ? or(...preds)! : and(...preds)!;
}

export interface ArticleScope {
	feedId?: number;
	collectionId?: number;
	tagId?: number;
	smart?: SmartRules;
	filter?: ArticleFilter;
	query?: string;
	limit?: number;
}

/**
 * Shared scope conditions for the article list and bulk triage: every
 * condition the list applies (subscription/feed ownership, feed/collection/
 * tag/smart predicates, today/saved windows, keyword query) so "mark all as
 * read" marks exactly what the view shows. Ordering/limit stay in getArticles.
 */
function buildArticleScopeConds(userId: string, opts: Omit<ArticleScope, 'limit'>) {
	const { feedId, collectionId, tagId, smart, filter = 'all', query } = opts;
	const conds = [eq(subscription.userId, userId), eq(feed.userId, userId)];
	if (feedId) conds.push(eq(article.feedId, feedId));
	if (collectionId) conds.push(eq(subscription.collectionId, collectionId));
	if (tagId) {
		conds.push(
			sql`exists (select 1 from ${articleTag} where ${articleTag.articleId} = ${article.id} and ${articleTag.tagId} = ${tagId})`
		);
	}
	if (smart) {
		const smartCond = smartRulesConditions(normalizeSmartRules(smart), userId);
		if (smartCond) conds.push(smartCond);
	}
	if (filter === 'today') {
		const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		// "Today" is the what's-new inbox, not a pure publish-date window: a
		// feed's backlog is new to the reader the moment it arrives, even when
		// the posts themselves are older. Anything published — or first seen —
		// inside the window counts, so subscribing to a quiet feed still fills
		// Today instead of showing a single story.
		conds.push(or(gte(article.publishedAt, dayAgo), gte(article.createdAt, dayAgo))!);
	}
	if (filter === 'saved') conds.push(eq(userArticleState.isSaved, true));
	if (query?.trim()) {
		const q = `%${query.trim()}%`;
		conds.push(or(ilike(article.title, q), ilike(article.excerpt, q), ilike(article.author, q))!);
	}
	return conds;
}

export async function getArticles(userId: string, opts: ArticleScope) {
	const { limit = 100 } = opts;
	const conds = buildArticleScopeConds(userId, opts);
	const rows = await db
		.select({
			id: article.id,
			feedId: article.feedId,
			feedTitle: feed.title,
			title: article.title,
			link: article.link,
			author: article.author,
			publishedAt: article.publishedAt,
			excerpt: article.excerpt,
			imageUrl: article.imageUrl,
			isRead: sql<boolean>`coalesce(${userArticleState.isRead}, false)`.mapWith(Boolean),
			isSaved: sql<boolean>`coalesce(${userArticleState.isSaved}, false)`.mapWith(Boolean),
			readMinutes:
				sql<number>`greatest(1, ceil(length(regexp_replace(coalesce(${article.contentHtml}, ${article.excerpt}, ''), '<[^>]+>', '', 'g')) / 1320.0)::int)`.mapWith(
					Number
				)
		})
		.from(article)
		.innerJoin(feed, eq(feed.id, article.feedId))
		.innerJoin(subscription, and(eq(subscription.feedId, feed.id), eq(subscription.userId, userId)))
		.leftJoin(
			userArticleState,
			and(eq(userArticleState.articleId, article.id), eq(userArticleState.userId, userId))
		)
		.where(and(...conds))
		// Undated items (some feeds omit <pubDate> entirely) would pin to the
		// top under Postgres' NULLS FIRST default for DESC; sort them by
		// arrival instead.
		.orderBy(desc(sql`coalesce(${article.publishedAt}, ${article.createdAt})`), desc(article.id))
		.limit(limit);
	return rows;
}

/** Cheap count for the smart-view builder preview. */
export async function countSmartPreview(userId: string, rules: SmartRules) {
	const conds = [eq(subscription.userId, userId), eq(feed.userId, userId)];
	const smartCond = smartRulesConditions(normalizeSmartRules(rules), userId);
	if (smartCond) conds.push(smartCond);
	const rows = await db
		.select({ n: sql<number>`count(*)`.mapWith(Number) })
		.from(article)
		.innerJoin(feed, eq(feed.id, article.feedId))
		.innerJoin(subscription, and(eq(subscription.feedId, feed.id), eq(subscription.userId, userId)))
		.leftJoin(
			userArticleState,
			and(eq(userArticleState.articleId, article.id), eq(userArticleState.userId, userId))
		)
		.where(and(...conds));
	return rows[0]?.n ?? 0;
}

export async function getArticleById(userId: string, id: number) {
	const rows = await db
		.select({
			id: article.id,
			feedId: article.feedId,
			feedTitle: feed.title,
			title: article.title,
			link: article.link,
			author: article.author,
			publishedAt: article.publishedAt,
			excerpt: article.excerpt,
			contentHtml: article.contentHtml,
			imageUrl: article.imageUrl,
			isRead: sql<boolean>`coalesce(${userArticleState.isRead}, false)`.mapWith(Boolean),
			isSaved: sql<boolean>`coalesce(${userArticleState.isSaved}, false)`.mapWith(Boolean)
		})
		.from(article)
		.innerJoin(feed, eq(feed.id, article.feedId))
		.innerJoin(subscription, and(eq(subscription.feedId, feed.id), eq(subscription.userId, userId)))
		.leftJoin(
			userArticleState,
			and(eq(userArticleState.articleId, article.id), eq(userArticleState.userId, userId))
		)
		.where(and(eq(article.id, id), eq(feed.userId, userId)))
		.limit(1);
	const row = rows[0] ?? null;
	if (!row) return null;
	// Rows stored before the dedupe fix still embed the hero image as the
	// first body `<img>` — strip it at read time so it renders once.
	return { ...row, contentHtml: stripDuplicateImage(row.contentHtml, row.imageUrl) };
}

/** True when the feed that owns this article belongs to the user. */
async function canAccessArticle(userId: string, articleId: number) {
	const rows = await db
		.select({ id: feed.id })
		.from(feed)
		.innerJoin(article, eq(article.feedId, feed.id))
		.where(and(eq(feed.userId, userId), eq(article.id, articleId)))
		.limit(1);
	return rows.length > 0;
}

async function upsertState(
	userId: string,
	articleId: number,
	patch: { isRead?: boolean; isSaved?: boolean }
) {
	if (!(await canAccessArticle(userId, articleId))) return;
	await db
		.insert(userArticleState)
		.values({
			userId,
			articleId,
			isRead: patch.isRead ?? false,
			isSaved: patch.isSaved ?? false,
			updatedAt: new Date()
		})
		.onConflictDoUpdate({
			target: [userArticleState.userId, userArticleState.articleId],
			set: { ...patch, updatedAt: new Date() }
		});
}

export async function markRead(userId: string, articleId: number, isRead = true) {
	await upsertState(userId, articleId, { isRead });
}

export async function toggleRead(userId: string, articleId: number) {
	if (!(await canAccessArticle(userId, articleId))) return false;
	const rows = await db
		.select({ isRead: userArticleState.isRead })
		.from(userArticleState)
		.where(and(eq(userArticleState.userId, userId), eq(userArticleState.articleId, articleId)))
		.limit(1);
	const next = !(rows[0]?.isRead ?? false);
	await upsertState(userId, articleId, { isRead: next });
	return next;
}

/**
 * Bulk triage: mark every article in a list scope as read in one statement.
 * Reuses the list's scope conditions (ownership included) so it marks exactly
 * what the view shows. Mirrors the list page size — the visible window, not
 * the unbounded scope. No behavioral events: bulk marks must not spam the
 * telemetry log or distort Recommended affinities.
 */
export async function markScopeRead(
	userId: string,
	scope: Omit<ArticleScope, 'limit'> & { limit?: number }
): Promise<{ marked: number }> {
	const { limit = 100, ...condsOpts } = scope;
	// Recommended is a personalized ranking, not a stable chronological set:
	// resolve the same ranking the list shows, then mark its visible window
	// (unread only, in ranked order) so bulk-mark matches the rendered list.
	if (
		condsOpts.filter === 'recommended' &&
		!condsOpts.collectionId &&
		!condsOpts.tagId &&
		!condsOpts.smart
	) {
		const ranked = await getRecommendedArticles(userId, {
			feedId: condsOpts.feedId,
			query: condsOpts.query,
			limit
		});
		const ids = ranked.filter((r) => !r.isRead).map((r) => ({ id: r.id }));
		if (ids.length === 0) return { marked: 0 };
		const now = new Date();
		await db
			.insert(userArticleState)
			.values(ids.map((r) => ({ userId, articleId: r.id, isRead: true, updatedAt: now })))
			.onConflictDoUpdate({
				target: [userArticleState.userId, userArticleState.articleId],
				set: { isRead: true, updatedAt: now }
			});
		return { marked: ids.length };
	}
	// A smart view's other predicates already filter by recency/keywords, so
	// the list resolves them with filter='all' (see +page.server.ts load) —
	// do the same here so bulk-mark matches the rendered list.
	const filter = condsOpts.filter === 'recommended' ? 'all' : (condsOpts.filter ?? 'all');
	const conds = buildArticleScopeConds(userId, { ...condsOpts, filter });
	const ids = await db
		.select({ id: article.id })
		.from(article)
		.innerJoin(feed, eq(feed.id, article.feedId))
		.innerJoin(subscription, and(eq(subscription.feedId, feed.id), eq(subscription.userId, userId)))
		.leftJoin(
			userArticleState,
			and(eq(userArticleState.articleId, article.id), eq(userArticleState.userId, userId))
		)
		.where(and(...conds, sql`coalesce(${userArticleState.isRead}, false) = false`))
		.orderBy(desc(sql`coalesce(${article.publishedAt}, ${article.createdAt})`), desc(article.id))
		.limit(limit);
	if (ids.length === 0) return { marked: 0 };
	const now = new Date();
	await db
		.insert(userArticleState)
		.values(ids.map((r) => ({ userId, articleId: r.id, isRead: true, updatedAt: now })))
		.onConflictDoUpdate({
			target: [userArticleState.userId, userArticleState.articleId],
			set: { isRead: true, updatedAt: now }
		});
	return { marked: ids.length };
}

export async function toggleSaved(userId: string, articleId: number) {
	if (!(await canAccessArticle(userId, articleId))) return;
	const rows = await db
		.select({ isSaved: userArticleState.isSaved })
		.from(userArticleState)
		.where(and(eq(userArticleState.userId, userId), eq(userArticleState.articleId, articleId)))
		.limit(1);
	await upsertState(userId, articleId, { isSaved: !(rows[0]?.isSaved ?? false) });
	// A save is explicit taste evidence — refresh the semantic model so the
	// next Recommended load reflects it (throttled, never blocks).
	scheduleInterestRefresh(userId);
}

// ---------------------------------------------------------------------------
// Recommended feed: behavior log + heuristic ranking
// ---------------------------------------------------------------------------

/**
 * Append a behavioral event and roll its aggregates into user_article_state.
 * `value` units: dwell → ms, scroll → percent 0–100, others ignored.
 */
export async function logArticleEvent(
	userId: string,
	articleId: number,
	kind: ArticleEventKind,
	value = 0
) {
	if (!(await canAccessArticle(userId, articleId))) return;
	const safeValue = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
	await db.insert(articleEvent).values({ userId, articleId, kind, value: safeValue });
	const now = new Date();
	if (kind === 'open') {
		await db
			.insert(userArticleState)
			.values({ userId, articleId, isRead: true, openCount: 1, lastOpenedAt: now, updatedAt: now })
			.onConflictDoUpdate({
				target: [userArticleState.userId, userArticleState.articleId],
				set: {
					isRead: true,
					openCount: sql`${userArticleState.openCount} + 1`,
					lastOpenedAt: now,
					updatedAt: now
				}
			});
	} else if (kind === 'dwell' && safeValue > 0) {
		await db
			.insert(userArticleState)
			.values({ userId, articleId, totalDwellMs: safeValue, updatedAt: now })
			.onConflictDoUpdate({
				target: [userArticleState.userId, userArticleState.articleId],
				set: { totalDwellMs: sql`${userArticleState.totalDwellMs} + ${safeValue}`, updatedAt: now }
			});
	} else if (kind === 'scroll') {
		const pct = Math.min(100, safeValue);
		const existing = await db
			.select({ max: userArticleState.maxScrollPct })
			.from(userArticleState)
			.where(and(eq(userArticleState.userId, userId), eq(userArticleState.articleId, articleId)))
			.limit(1);
		if ((existing[0]?.max ?? 0) >= pct) return;
		await db
			.insert(userArticleState)
			.values({ userId, articleId, maxScrollPct: pct, updatedAt: now })
			.onConflictDoUpdate({
				target: [userArticleState.userId, userArticleState.articleId],
				set: { maxScrollPct: pct, updatedAt: now }
			});
	} else if (kind === 'finish') {
		await db
			.insert(userArticleState)
			.values({ userId, articleId, isRead: true, finished: true, updatedAt: now })
			.onConflictDoUpdate({
				target: [userArticleState.userId, userArticleState.articleId],
				set: { isRead: true, finished: true, updatedAt: now }
			});
	}
	// Open/finish carry the strongest interest signal — refresh the semantic
	// model in the background so the next Recommended load re-ranks. Deep
	// dwell (30s+) and near-complete scroll (75%+) also refresh via the same
	// 60s throttle; cheap beacons below that stay write-only. Share/save are
	// strong explicit signals and refresh too.
	if (kind === 'open' || kind === 'finish' || kind === 'share' || kind === 'save') {
		scheduleInterestRefresh(userId);
	} else if (kind === 'dwell' && safeValue >= 30_000) {
		scheduleInterestRefresh(userId);
	} else if (kind === 'scroll' && safeValue >= 75) {
		scheduleInterestRefresh(userId);
	}
	if (kind === 'dismiss' || kind === 'mute_feed' || kind === 'mute_topic') {
		await recordFeedback(userId, articleId, kind);
		scheduleInterestRefresh(userId);
	}
}

/**
 * Persist explicit negative feedback ("Not interested" / "Don't show this
 * feed/topic"). The article_event row (written by the caller) keeps the raw
 * log; this adds a structured row to user_feedback for fast filtering.
 * `mute_topic` mutes the article's top tag. Never throws: pre-migration DBs
 * without the table simply read as "no feedback" downstream.
 */
export async function recordFeedback(
	userId: string,
	articleId: number,
	kind: FeedbackKind
): Promise<void> {
	try {
		if (kind === 'dismiss') {
			await db.insert(userFeedback).values({ userId, kind, articleId });
			return;
		}
		const rows = await db
			.select({ feedId: article.feedId })
			.from(article)
			.where(eq(article.id, articleId))
			.limit(1);
		const feedId = rows[0]?.feedId;
		if (kind === 'mute_feed' && feedId) {
			await db.insert(userFeedback).values({ userId, kind, articleId, feedId });
			return;
		}
		if (kind === 'mute_topic') {
			const tagRows = await db
				.select({ name: tag.name })
				.from(articleTag)
				.innerJoin(tag, and(eq(tag.id, articleTag.tagId), eq(tag.userId, userId)))
				.where(eq(articleTag.articleId, articleId))
				.limit(1);
			const topic = tagRows[0]?.name?.toLowerCase().slice(0, 60);
			if (topic) await db.insert(userFeedback).values({ userId, kind, articleId, topic });
		}
	} catch (e) {
		console.error('feedback record failed', e);
	}
}

/** Recent explicit feedback for ranking: dismissed article ids, muted feed
 *  ids and muted topics. Missing-table DBs return empty sets. */
export async function getFeedbackFilter(userId: string): Promise<{
	dismissed: Set<number>;
	mutedFeeds: Set<number>;
	mutedTopics: Set<string>;
}> {
	const empty = {
		dismissed: new Set<number>(),
		mutedFeeds: new Set<number>(),
		mutedTopics: new Set<string>()
	};
	try {
		const rows = await db
			.select({
				kind: userFeedback.kind,
				articleId: userFeedback.articleId,
				feedId: userFeedback.feedId,
				topic: userFeedback.topic
			})
			.from(userFeedback)
			.where(eq(userFeedback.userId, userId))
			.orderBy(desc(userFeedback.createdAt))
			.limit(500);
		for (const r of rows) {
			if (r.kind === 'dismiss' && r.articleId) empty.dismissed.add(r.articleId);
			else if (r.kind === 'mute_feed' && r.feedId) empty.mutedFeeds.add(r.feedId);
			else if (r.kind === 'mute_topic' && r.topic) empty.mutedTopics.add(r.topic.toLowerCase());
		}
		// Legacy path: explicit dismiss/mute article_events predate the table.
		const legacy = await db
			.select({ kind: articleEvent.kind, articleId: articleEvent.articleId })
			.from(articleEvent)
			.where(eq(articleEvent.userId, userId))
			.orderBy(desc(articleEvent.createdAt))
			.limit(500);
		for (const r of legacy) {
			if (r.kind === 'dismiss') empty.dismissed.add(r.articleId);
		}
	} catch (e) {
		console.error('feedback filter load failed', e);
	}
	return empty;
}

async function getAffinityMaps(userId: string, now = Date.now()): Promise<AffinityMaps> {
	// Engagement-driven pass: every recent state contributes its interaction
	// weight decayed by age. Bounces and untouched rows contribute nothing —
	// affinity is earned by opens, dwell, scroll, finishes and saves.
	const states = await db
		.select({
			articleId: article.id,
			feedId: article.feedId,
			author: article.author,
			openCount: userArticleState.openCount,
			isRead: userArticleState.isRead,
			isSaved: userArticleState.isSaved,
			finished: userArticleState.finished,
			totalDwellMs: userArticleState.totalDwellMs,
			maxScrollPct: userArticleState.maxScrollPct,
			updatedAt: userArticleState.updatedAt
		})
		.from(userArticleState)
		.innerJoin(article, eq(article.id, userArticleState.articleId))
		.innerJoin(feed, and(eq(feed.id, article.feedId), eq(feed.userId, userId)))
		.where(eq(userArticleState.userId, userId))
		.orderBy(desc(userArticleState.updatedAt))
		.limit(300);

	// Tags per engaged article (credit is split across an article's tags so
	// multi-tag articles don't dominate the histogram).
	const tagByArticle = new Map<number, string[]>();
	const engagedIds = [...new Set(states.map((s) => s.articleId))];
	if (engagedIds.length > 0) {
		const tagRows = await db
			.select({ articleId: articleTag.articleId, name: tag.name })
			.from(articleTag)
			.innerJoin(tag, and(eq(tag.id, articleTag.tagId), eq(tag.userId, userId)))
			.where(inArray(articleTag.articleId, engagedIds));
		for (const r of tagRows) {
			const list = tagByArticle.get(r.articleId) ?? [];
			list.push(r.name.toLowerCase());
			tagByArticle.set(r.articleId, list);
		}
	}

	const feedCounts = new Map<number, number>();
	const tagCounts = new Map<string, number>();
	const authorCounts = new Map<string, number>();
	// YouTube-style split: long-term taste (30d half-life), short-term
	// session (48h half-life, "what I'm into right now"), and persistent
	// negatives (bounces + explicit dismiss/mute feedback).
	const negFeedCounts = new Map<number, number>();
	const negTagCounts = new Map<string, number>();
	const shortFeedCounts = new Map<number, number>();
	const shortTagCounts = new Map<string, number>();
	// Explicit feedback joins the negative stream with fixed weights:
	// a dismiss ≈ 3 bounces, a feed mute ≈ 5, a topic mute ≈ 4.
	let feedback: { mutedFeeds: Set<number>; mutedTopics: Set<string> } = {
		mutedFeeds: new Set(),
		mutedTopics: new Set()
	};
	try {
		feedback = await getFeedbackFilter(userId);
	} catch {
		// Pre-migration or transient failure — negatives degrade gracefully.
	}
	for (const fid of feedback.mutedFeeds) {
		negFeedCounts.set(fid, (negFeedCounts.get(fid) ?? 0) + 6);
	}
	const mutedTopicList = [...feedback.mutedTopics];
	for (const s of states) {
		const w = interactionWeight({
			openCount: s.openCount,
			isRead: s.isRead,
			isSaved: s.isSaved,
			finished: s.finished,
			totalDwellMs: s.totalDwellMs,
			maxScrollPct: s.maxScrollPct
		});
		const ageMs = now - (s.updatedAt?.getTime() ?? now);
		const tags = tagByArticle.get(s.articleId) ?? [];
		if (w < 0) {
			// Bounce: negative evidence, decayed slowly so quick rejects linger.
			const nw = Math.abs(w) * timeDecay(ageMs, ENGAGEMENT_HALF_LIFE_MS);
			negFeedCounts.set(s.feedId, (negFeedCounts.get(s.feedId) ?? 0) + nw);
			if (tags.length > 0) {
				const share = nw / tags.length;
				for (const t of tags) negTagCounts.set(t, (negTagCounts.get(t) ?? 0) + share);
			}
			continue;
		}
		if (!(w > 0)) continue;
		const long = w * timeDecay(ageMs, ENGAGEMENT_HALF_LIFE_MS);
		const short = w * timeDecay(ageMs, SESSION_HALF_LIFE_MS);
		feedCounts.set(s.feedId, (feedCounts.get(s.feedId) ?? 0) + long);
		shortFeedCounts.set(s.feedId, (shortFeedCounts.get(s.feedId) ?? 0) + short);
		if (s.author?.trim()) {
			const key = s.author.trim().toLowerCase();
			authorCounts.set(key, (authorCounts.get(key) ?? 0) + long);
		}
		if (tags.length > 0) {
			const longShare = long / tags.length;
			const shortShare = short / tags.length;
			for (const t of tags) {
				tagCounts.set(t, (tagCounts.get(t) ?? 0) + longShare);
				shortTagCounts.set(t, (shortTagCounts.get(t) ?? 0) + shortShare);
			}
		}
	}
	for (const t of mutedTopicList) {
		negTagCounts.set(t, (negTagCounts.get(t) ?? 0) + 5);
	}
	return buildAffinityMaps({
		feedCounts,
		tagCounts,
		authorCounts,
		negFeedCounts,
		negTagCounts,
		shortFeedCounts,
		shortTagCounts
	});
}

/** Unread stories from the last 14 days — badge count for the sidebar. */
export async function getRecommendedCount(userId: string): Promise<number> {
	const since = new Date(Date.now() - 14 * 86400000);
	const rows = await db
		.select({ n: sql<number>`count(*)`.mapWith(Number) })
		.from(article)
		.innerJoin(feed, eq(feed.id, article.feedId))
		.innerJoin(subscription, and(eq(subscription.feedId, feed.id), eq(subscription.userId, userId)))
		.leftJoin(
			userArticleState,
			and(eq(userArticleState.articleId, article.id), eq(userArticleState.userId, userId))
		)
		.where(
			and(
				eq(subscription.userId, userId),
				eq(feed.userId, userId),
				or(gte(article.publishedAt, since), gte(article.createdAt, since))!,
				sql`coalesce(${userArticleState.isRead}, false) = false`
			)
		);
	return rows[0]?.n ?? 0;
}

/**
 * Recommended articles: candidate generation (last 14d, up to 500) +
 * engagement-weighted re-rank with semantic, IDF and MMR diversity layers.
 * Cold-start users (no weighted engagement) fall back to Today ordering so
 * the view is useful immediately. A non-empty `query` switches to the search
 * profile: query intent dominates and feed affinity is ignored.
 */
// Query embeddings are deterministic: process-wide cache so repeat searches
// skip inference entirely.
const QUERY_VEC_CACHE_MAX = 200;
const queryVecCache = new Map<string, number[]>();
export async function getRecommendedArticles(
	userId: string,
	opts: {
		limit?: number;
		query?: string;
		feedId?: number;
		seed?: string | number;
		/** Shuffle-button remix: amplify the exploration slot beyond the
		 *  gentle sidebar re-click level. */
		deep?: boolean;
	} = {}
) {
	const { limit = 100, query, feedId, seed = '', deep = false } = opts;
	const trimmedQuery = query?.trim() ?? '';
	const isSearch = trimmedQuery.length > 0;
	// Semantic search: embed the query once, then rank the whole recent window
	// by cosine similarity instead of substring filtering. When the embedding
	// model is unavailable (keyword-only mode) fall back to the ilike filter.
	// Query embeddings are deterministic: cache them so repeat searches
	// (backspace, revisit, per-keystroke overlap) skip inference entirely.
	const cacheKey = trimmedQuery.toLowerCase();
	let queryVec: number[] | null = queryVecCache.get(cacheKey) ?? null;
	if (isSearch && !queryVec) {
		try {
			const { embedText } = await import('$lib/server/enrich/embeddings');
			queryVec = await embedText(trimmedQuery);
			if (queryVec) {
				queryVecCache.set(cacheKey, queryVec);
				if (queryVecCache.size > QUERY_VEC_CACHE_MAX) {
					const oldest = queryVecCache.keys().next().value;
					if (oldest !== undefined) queryVecCache.delete(oldest);
				}
			}
		} catch {
			queryVec = null;
		}
	}
	const now = Date.now();
	// Affinities first: recall needs top-feed ids (affinity depth) and the
	// muted-feed list (hard filter). Search skips this — query intent rules.
	const affinities = isSearch ? null : await getAffinityMaps(userId, now);
	const feedback = isSearch
		? {
				dismissed: new Set<number>(),
				mutedFeeds: new Set<number>(),
				mutedTopics: new Set<string>()
			}
		: await getFeedbackFilter(userId);
	const since = new Date(Date.now() - 14 * 86400000);
	// Same "new to the reader" semantics as the Today filter: a feed's
	// backlog counts if published OR first seen inside the window, so a
	// freshly added feed shows up instead of being filtered out for having
	// old <pubDate>s.
	const baseConds = [
		eq(subscription.userId, userId),
		eq(feed.userId, userId),
		or(gte(article.publishedAt, since), gte(article.createdAt, since))!
	];
	if (feedId) baseConds.push(eq(article.feedId, feedId));
	const mutedFeedIds = [...feedback.mutedFeeds];
	if (mutedFeedIds.length > 0 && !feedId) {
		// Muted feeds never surface in Recommended (explicit scope still works).
		baseConds.push(sql`${article.feedId} NOT IN (${sql.join(mutedFeedIds, sql`, `)})`);
	}
	const rowSelect = {
		id: article.id,
		feedId: article.feedId,
		feedTitle: feed.title,
		title: article.title,
		link: article.link,
		author: article.author,
		publishedAt: article.publishedAt,
		excerpt: article.excerpt,
		imageUrl: article.imageUrl,
		isRead: sql<boolean>`coalesce(${userArticleState.isRead}, false)`.mapWith(Boolean),
		isSaved: sql<boolean>`coalesce(${userArticleState.isSaved}, false)`.mapWith(Boolean),
		readMinutes:
			sql<number>`greatest(1, ceil(length(regexp_replace(coalesce(${article.contentHtml}, ${article.excerpt}, ''), '<[^>]+>', '', 'g')) / 1320.0)::int)`.mapWith(
				Number
			)
	};
	function rowQuery(extraConds: ReturnType<typeof eq>[], orderOffset = 0, pageLimit = 350) {
		return db
			.select(rowSelect)
			.from(article)
			.innerJoin(feed, eq(feed.id, article.feedId))
			.innerJoin(
				subscription,
				and(eq(subscription.feedId, feed.id), eq(subscription.userId, userId))
			)
			.leftJoin(
				userArticleState,
				and(eq(userArticleState.articleId, article.id), eq(userArticleState.userId, userId))
			)
			.where(and(...baseConds, ...extraConds))
			.orderBy(desc(sql`coalesce(${article.publishedAt}, ${article.createdAt})`), desc(article.id))
			.limit(pageLimit)
			.offset(orderOffset);
	}
	let rows: Awaited<ReturnType<typeof rowQuery>>;
	if (isSearch) {
		const searchConds: ReturnType<typeof eq>[] = [];
		if (!queryVec) {
			const q = `%${trimmedQuery}%`;
			searchConds.push(
				or(ilike(article.title, q), ilike(article.excerpt, q), ilike(article.author, q))!
			);
		}
		rows = await rowQuery(searchConds, 0, 500);
	} else {
		// YouTube-style multi-source recall, merged + deduped below:
		// 1) recency — the fresh surface (subscribed, newest first);
		// 2) affinity depth — older gems from top-taste feeds past the
		//    recency cutoff, so a great 10-day-old story isn't buried by
		//    350 newer strangers;
		// 3) exploration — newest items from feeds with no affinity yet, so
		//    quiet/new subscriptions always get a trial slot.
		const topFeeds =
			affinities != null
				? [...affinities.feedScores.entries()]
						.sort((a, b) => b[1] - a[1])
						.slice(0, 8)
						.map(([fid]) => fid)
				: [];
		const affinityConds: ReturnType<typeof eq>[] =
			topFeeds.length > 0 ? [inArray(article.feedId, topFeeds)] : [];
		const exploreConds: ReturnType<typeof eq>[] =
			topFeeds.length > 0 ? [sql`${article.feedId} NOT IN (${sql.join(topFeeds, sql`, `)})`] : [];
		// Depth uses offset 0 (not 120): a favorite feed with few items would
		// otherwise return nothing past the offset, starving low-volume
		// favorites. Overlap with `recent` is removed by the dedupe below.
		const [recent, depth, explore] = await Promise.all([
			rowQuery([], 0, 320),
			topFeeds.length > 0 ? rowQuery(affinityConds, 0, 150) : Promise.resolve([]),
			rowQuery(exploreConds, 0, 100)
		]);
		const seen = new Set<number>();
		rows = [];
		for (const r of [...recent, ...depth, ...explore]) {
			if (seen.has(r.id)) continue;
			seen.add(r.id);
			rows.push(r);
		}
		rows = rows.slice(0, 550);
	}
	// Dismissed articles never resurface (until re-added by refresh).
	if (feedback.dismissed.size > 0) {
		rows = rows.filter((r) => !feedback.dismissed.has(r.id));
	}
	// Cold-start users have no taste affinities, but scoring still ranks by
	// freshness + quality + trending + unread instead of raw recency, so the
	// first screen is the best of the window rather than just the newest.
	// (No early chronological return here — the scorer below degrades
	// gracefully with empty affinity maps.)
	const aff =
		affinities ??
		buildAffinityMaps({ feedCounts: new Map(), tagCounts: new Map(), authorCounts: new Map() });

	const candidateIds = rows.map((r) => r.id);
	const [tagMap, candidateStates, embeddingRows, interestRows, shortEngaged] = await Promise.all([
		getTagsForArticles(userId, candidateIds),
		candidateIds.length > 0
			? db
					.select({
						articleId: userArticleState.articleId,
						finished: userArticleState.finished,
						totalDwellMs: userArticleState.totalDwellMs,
						maxScrollPct: userArticleState.maxScrollPct
					})
					.from(userArticleState)
					.where(
						and(
							eq(userArticleState.userId, userId),
							inArray(userArticleState.articleId, candidateIds)
						)
					)
			: Promise.resolve([]),
		candidateIds.length > 0
			? db
					.select({
						articleId: articleEmbedding.articleId,
						embedding: articleEmbedding.embedding,
						topics: articleEmbedding.topics
					})
					.from(articleEmbedding)
					.where(inArray(articleEmbedding.articleId, candidateIds))
			: Promise.resolve([]),
		// Search mode ranks against the query vector; the interest model is
		// only needed for plain recommendations.
		isSearch
			? Promise.resolve([])
			: db
					.select({ embedding: userInterest.embedding })
					.from(userInterest)
					.where(eq(userInterest.userId, userId))
					.limit(1),
		// Short-term ("reading right now") semantic target: the freshest
		// positively-engaged embeddings. Small (12 rows) and skipped for search.
		isSearch
			? Promise.resolve([])
			: db
					.select({
						embedding: articleEmbedding.embedding,
						openCount: userArticleState.openCount,
						isRead: userArticleState.isRead,
						isSaved: userArticleState.isSaved,
						finished: userArticleState.finished,
						totalDwellMs: userArticleState.totalDwellMs,
						maxScrollPct: userArticleState.maxScrollPct,
						updatedAt: userArticleState.updatedAt
					})
					.from(userArticleState)
					.innerJoin(article, eq(article.id, userArticleState.articleId))
					.innerJoin(feed, and(eq(feed.id, article.feedId), eq(feed.userId, userId)))
					.innerJoin(articleEmbedding, eq(articleEmbedding.articleId, article.id))
					.where(eq(userArticleState.userId, userId))
					.orderBy(desc(userArticleState.updatedAt))
					.limit(12)
	]);
	// A search query vector takes priority over the interest model: "what
	// I'm looking for right now" beats "what I generally read".
	const semanticTarget = queryVec ?? interestRows[0]?.embedding ?? null;
	const embeddingById = new Map(embeddingRows.map((e) => [e.articleId, e]));
	const stateById = new Map(candidateStates.map((s) => [s.articleId, s]));
	// Session centroid: engagement-weighted mean of the freshest positive
	// interactions (48h half-life), normalized. Null when nothing recent.
	const shortCentroid: number[] | null = (() => {
		if (isSearch || shortEngaged.length === 0) return null;
		const acc: number[] = [];
		let dim = 0;
		let totalW = 0;
		for (const row of shortEngaged) {
			const vec = parseStoredVector(row.embedding);
			if (!vec || vec.length === 0) continue;
			const w =
				interactionWeight({
					openCount: row.openCount,
					isRead: row.isRead,
					isSaved: row.isSaved,
					finished: row.finished,
					totalDwellMs: row.totalDwellMs,
					maxScrollPct: row.maxScrollPct
				}) * timeDecay(now - (row.updatedAt?.getTime() ?? now), SESSION_HALF_LIFE_MS);
			if (!(w > 0.3)) continue;
			if (dim === 0) dim = vec.length;
			if (vec.length !== dim) continue;
			if (acc.length === 0) acc.push(...vec.map((x) => x * w));
			else for (let i = 0; i < dim; i++) acc[i] += vec[i] * w;
			totalW += w;
		}
		if (totalW <= 0 || acc.length === 0) return null;
		const mean = acc.map((x) => x / totalW);
		const norm = Math.sqrt(mean.reduce((s, x) => s + x * x, 0));
		return norm > 0 ? mean.map((x) => x / norm) : null;
	})();

	// Tag IDF over the candidate window: distinctive tags count more than
	// ubiquitous ones. Stored topics/entities join the tag vocabulary so
	// extractor wording can match the user's tag affinity.
	const tagsPerRow = new Map<number, string[]>();
	const docFreq = new Map<string, number>();
	for (const r of rows) {
		const names = (tagMap.get(r.id) ?? []).map((t) => t.name.toLowerCase());
		const stored = embeddingById.get(r.id);
		const extra = parseStoredStrings(stored?.topics)
			.map((t) => t.toLowerCase())
			.filter((t) => t.length >= 3 && t.length <= 60);
		const all = [...new Set([...names, ...extra])];
		tagsPerRow.set(r.id, all);
		for (const t of all) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
	}
	const tagIdf = new Map<string, number>();
	for (const [t, df] of docFreq) tagIdf.set(t, idfWeight(df, rows.length));
	// Topic-burst map: tags riding a burst of coverage get a small trending
	// boost (YouTube's trending shelf, cheap version — no CTR model needed).
	const bursts = isSearch ? new Map<string, number>() : burstBoosts(docFreq);
	const idfOf = (t: string) => tagIdf.get(t) ?? 1;

	// Feed volume normalization (pure — never mutates the cached affinity
	// maps): a feed with 40 recent items shouldn't auto-win over a quiet
	// feed the user loves equally.
	const feedVolume = new Map<number, number>();
	for (const r of rows) feedVolume.set(r.feedId, (feedVolume.get(r.feedId) ?? 0) + 1);
	const feedScores =
		isSearch || feedVolume.size === 0
			? aff.feedScores
			: normalizedFeedScores(aff.feedScores, feedVolume);
	const affScored: AffinityMaps = feedScores === aff.feedScores ? aff : { ...aff, feedScores };

	const mode = isSearch ? 'search' : 'recommend';
	const scored = rows.map((r) => {
		const st = stateById.get(r.id);
		const stored = embeddingById.get(r.id);
		const rowTags = tagsPerRow.get(r.id) ?? [];
		// Session affinity: short-term tag taste, IDF-weighted like long-term.
		const sessionBoost = isSearch ? 0 : tagAffinity(rowTags, affScored.shortTagScores, idfOf);
		// Short-term semantic: candidate vs "reading right now" centroid.
		let sessionSemantic = 0;
		if (!isSearch && shortCentroid) {
			const vec = parseStoredVector(stored?.embedding);
			if (vec) sessionSemantic = Math.max(0, cosineSimilarity(vec, shortCentroid));
		}
		let trendingBoost = 0;
		for (const t of rowTags) {
			const b = bursts.get(t) ?? 0;
			if (b > trendingBoost) trendingBoost = b;
		}
		const s = scoreCandidate(
			{
				id: r.id,
				feedId: r.feedId,
				author: r.author,
				publishedAt: r.publishedAt,
				isRead: r.isRead,
				isSaved: r.isSaved,
				tags: rowTags,
				semanticSimilarity: similarityToInterest(stored?.embedding, semanticTarget),
				finished: st?.finished ?? false,
				dwellMs: st?.totalDwellMs ?? null,
				scrollPct: st?.maxScrollPct ?? null,
				hasImage: !!r.imageUrl,
				excerptLength: r.excerpt?.length ?? 0,
				titleLength: r.title?.length ?? 0,
				title: r.title
			},
			affScored,
			{
				now,
				mode,
				tagIdf,
				sessionBoost,
				sessionSemantic,
				trendingBoost,
				keywordBoost: isSearch ? keywordMatchBoost(trimmedQuery, r) : 0,
				// An explicit shuffle seed elects a fresh exploration mix. The
				// sidebar re-click stays gentle (close-call swaps only); the
				// Shuffle button remixes deeper. Search never explores.
				explorationBoost:
					deterministicExploreBoost(userId, r.id, now, isSearch ? '' : seed) *
					(!isSearch && seed
						? deep
							? DEEP_SHUFFLE_EXPLORATION_MULTIPLIER
							: SHUFFLE_EXPLORATION_MULTIPLIER
						: 1)
			}
		);
		return {
			id: r.id,
			feedId: r.feedId,
			// Already-saved items get a nudge: the user explicitly kept them.
			score: s.score + (r.isSaved ? 0.02 : 0),
			components: s.components,
			embedding: parseStoredVector(stored?.embedding),
			topics: parseStoredStrings(stored?.topics),
			titleKey: canonicalTitleKey(r.title)
		};
	});
	if (isRecommendScoreLogEnabled()) {
		// Eval log (env-gated, best-effort — ranking never waits on it).
		// Components carry the seed/mode so offline replay can reconstruct
		// exploration + ranking context per impression batch.
		void db
			.insert(recommendScoreLog)
			.values(
				scored.slice(0, limit).map((s) => ({
					userId,
					articleId: s.id,
					score: s.score,
					components: { ...s.components, _mode: mode, _seed: String(seed), _deep: deep ? 1 : 0 }
				}))
			)
			.catch((e) => console.error('recommend score log failed', e));
	}
	// YouTube-Home-style final pass for Recommended: MMR diversity (no feed
	// or topic monopolizes the top) over near-duplicate-collapsed items,
	// then guaranteed exploration slots so new topics always surface.
	// Search keeps plain MMR over the unfiltered set.
	const rankItems = [...scored]
		.sort((a, b) => b.score - a.score)
		.map((s) => ({
			id: s.id,
			feedId: s.feedId,
			score: s.score,
			embedding: s.embedding,
			topics: s.topics,
			titleKey: s.titleKey
		}));
	const orderedIds = isSearch
		? rankWithMMR(rankItems)
		: injectExplorationSlots(
				rankWithMMR(rankItems, { lambda: 0.75, perFeedCap: 3, perTopicCap: 2 }),
				(id) => deterministicExploreBoost(userId, id, now, seed === '' ? 'slot' : seed) === 1,
				12
			);
	const byId = new Map(rows.map((r) => [r.id, r]));
	const ranked = orderedIds.map((id) => byId.get(id)).filter((r) => r != null);
	if (isSearch) return ranked.slice(0, limit);
	// Unread-first backfill: kept (unread or explicitly saved) stories hold
	// the top window in ranked order; opened stories backfill below instead
	// of crowding out unseen items.
	const kept: typeof ranked = [];
	const opened: typeof ranked = [];
	for (const r of ranked) (r.isSaved || !r.isRead ? kept : opened).push(r);
	return [...kept, ...opened].slice(0, limit);
}

/** Env-gated eval logging for the Recommended feed (off by default). */
export function isRecommendScoreLogEnabled(): boolean {
	return (env.RECOMMEND_LOG_SCORES ?? '0') === '1';
}

/**
 * Subscribe a user to one of their own feeds inside a collection.
 * Accepts a collection id or name (find-or-create); defaults to General.
 * The legacy `category` string is kept in sync for old clients.
 */
export async function subscribe(
	userId: string,
	feedId: number,
	collectionRef: number | string = GENERAL_COLLECTION
) {
	const owned = await db
		.select({ id: feed.id })
		.from(feed)
		.where(and(eq(feed.id, feedId), eq(feed.userId, userId)))
		.limit(1);
	if (owned.length === 0) return;
	const collectionId =
		typeof collectionRef === 'number'
			? collectionRef
			: await ensureCollectionByName(userId, collectionRef || GENERAL_COLLECTION);
	const target = await db
		.select({ name: collection.name })
		.from(collection)
		.where(and(eq(collection.id, collectionId), eq(collection.userId, userId)))
		.limit(1);
	if (!target[0]) throw new Error('Collection not found');
	await db
		.insert(subscription)
		.values({ userId, feedId, collectionId, category: target[0].name })
		.onConflictDoUpdate({
			target: [subscription.userId, subscription.feedId],
			set: { collectionId, category: target[0].name }
		});
}

export async function unsubscribe(userId: string, feedId: number) {
	await db
		.delete(subscription)
		.where(and(eq(subscription.userId, userId), eq(subscription.feedId, feedId)));
	// Feeds are private: removing the subscription orphans nothing else, so
	// delete the feed itself (articles cascade).
	await db.delete(feed).where(and(eq(feed.id, feedId), eq(feed.userId, userId)));
}

/**
 * Find-or-create the user's private feed and subscribe — fast path only.
 * No network I/O here: a placeholder row (hostname as title) is inserted so
 * the UI can close immediately, and populateFeed does the real
 * discovery/fetch in the background. `lastFetchedAt` is set so the page
 * reload right after adding doesn't re-fetch the feed synchronously.
 */
export async function addFeed(
	userId: string,
	inputUrl: string,
	collectionRef: number | string = GENERAL_COLLECTION
) {
	const existing = await db
		.select()
		.from(feed)
		.where(and(eq(feed.url, inputUrl), eq(feed.userId, userId)))
		.limit(1);
	let feedId = existing[0]?.id;
	if (!feedId) {
		let title = inputUrl;
		let siteUrl: string | null = null;
		try {
			const u = new URL(inputUrl);
			title = u.hostname;
			siteUrl = u.origin;
		} catch {
			// Keep the raw input as the title; populateFeed validates properly.
		}
		const inserted = await db
			.insert(feed)
			.values({ userId, url: inputUrl, title, siteUrl, lastFetchedAt: new Date() })
			.returning({ id: feed.id });
		feedId = inserted[0].id;
	}
	await subscribe(userId, feedId, collectionRef);
	return feedId;
}

/**
 * Background step of addFeed: discover the real feed URL, fetch it, backfill
 * title/site/icon, store items, then run feed-scoped full-text/enrichment
 * backfills so a freshly added feed is readable immediately instead of waiting
 * for the scheduler's small per-tick quotas. Never throws.
 *
 * Failure handling: a *transient* error (RSSHub cold start, DNS blip, 5xx) or
 * a discovery outage keeps the placeholder feed — with the best-known feed URL
 * persisted — so the scheduler can retry later. Only a definitive "this URL is
 * not a feed" response removes the placeholder so nothing broken lingers.
 */
export async function populateFeed(feedId: number, inputUrl: string) {
	let discovery: DiscoverResult | null = null;
	try {
		discovery = await discoverFeed(inputUrl);
		const parsed = discovery.parsed ?? (await fetchFeed(discovery.url));
		const url = discovery.url;
		const fromRsshub = isRsshubUrl(url);
		let rsshubRoute: string | null = null;
		if (fromRsshub) {
			try {
				rsshubRoute = new URL(url).pathname;
			} catch {
				rsshubRoute = null;
			}
		}
		await db
			.update(feed)
			.set({
				url,
				title: parsed.title,
				siteUrl: parsed.siteUrl,
				imageUrl: parsed.imageUrl,
				source: fromRsshub ? 'rsshub' : 'rss',
				rsshubRoute,
				lastFetchedAt: new Date()
			})
			.where(eq(feed.id, feedId));
		await upsertItems(feedId, parsed.items);
		// First items just landed: scrape/enrich them now rather than letting
		// the scheduler's global quotas starve this feed for several ticks.
		await backfillNewFeedItems(feedId);
	} catch (e) {
		console.error(`populateFeed failed for ${inputUrl}`, e);
		// Discovery reports verified=true only after a successful parse, so a
		// later failure there is also transient (e.g. the refetch). radarFailed
		// means RSSHub was down and we could not even ask for a route.
		const retryable =
			discovery === null || discovery.verified || discovery.radarFailed || isTransientFeedError(e);
		if (retryable) {
			// Keep the placeholder but persist the best-known URL so the
			// scheduler's refresh path retries the real feed target, not the
			// pasted page. `lastFetchedAt` stays as-is: addFeed set it, so the
			// next stale check (≤15 min) picks the feed up again.
			if (discovery && discovery.url !== inputUrl) {
				try {
					const fromRsshub = isRsshubUrl(discovery.url);
					let rsshubRoute: string | null = null;
					if (fromRsshub) {
						try {
							rsshubRoute = new URL(discovery.url).pathname;
						} catch {
							rsshubRoute = null;
						}
					}
					await db
						.update(feed)
						.set({ url: discovery.url, source: fromRsshub ? 'rsshub' : 'rss', rsshubRoute })
						.where(eq(feed.id, feedId));
				} catch (dbErr) {
					console.error(`populateFeed could not persist discovered url for ${inputUrl}`, dbErr);
				}
			}
			return;
		}
		// The URL had no usable feed: clean up the placeholder row.
		try {
			await db.delete(subscription).where(eq(subscription.feedId, feedId));
			await db.delete(feed).where(eq(feed.id, feedId));
		} catch (dbErr) {
			console.error(`populateFeed cleanup failed for ${inputUrl}`, dbErr);
		}
	}
}

/**
 * Feed-scoped catch-up after items first land: full-text scrape for truncated
 * bodies, then tagging/topics. The per-run quotas (default 10 scrapes /
 * 25 enrichments) are smaller than a full RSSHub page (up to 50 items), so
 * each backfill loops until caught up, bounded so a pathological run can
 * never spin forever. Every pass is isolated so a scrape/enrich failure
 * never propagates up to the feed that was just added.
 */
export async function backfillNewFeedItems(feedId: number): Promise<void> {
	if (isFulltextAutoEnabled()) {
		for (let pass = 0; pass < 10; pass++) {
			try {
				const r = await backfillTruncatedArticles({ feedId });
				if (r.scraped + r.failed === 0) break;
			} catch (e) {
				console.error(`initial fulltext backfill failed for feed ${feedId}`, e);
				break;
			}
		}
	}
	if (isEnrichAutoEnabled()) {
		for (let pass = 0; pass < 10; pass++) {
			try {
				const r = await backfillUnenrichedArticles({ feedId });
				if (r.enriched + r.failed === 0) break;
			} catch (e) {
				console.error(`initial enrich backfill failed for feed ${feedId}`, e);
				break;
			}
		}
	}
}

export async function upsertItems(
	feedId: number,
	items: Awaited<ReturnType<typeof fetchFeed>>['items']
) {
	for (const item of items) {
		// One malformed item must not abort the whole batch (and the
		// feed-scoped backfills that follow a populate/heal): log and keep
		// inserting the rest.
		try {
			await db
				.insert(article)
				.values({
					feedId,
					guid: item.guid.slice(0, 500),
					title: item.title,
					link: item.link,
					author: item.author,
					publishedAt: item.publishedAt,
					excerpt: item.excerpt,
					contentHtml: item.contentHtml,
					imageUrl: item.imageUrl
				})
				.onConflictDoNothing({ target: [article.feedId, article.guid] });
		} catch (e) {
			console.error(`upsertItems skipped item ${item.guid.slice(0, 200)} of feed ${feedId}`, e);
		}
	}
	// Feed `<category>` values become user tags: resolve the feed owner once,
	// then attach tags to the upserted rows (idempotent via the unique index).
	const owner = await db
		.select({ userId: feed.userId })
		.from(feed)
		.where(eq(feed.id, feedId))
		.limit(1);
	const userId = owner[0]?.userId;
	if (userId) await attachFeedTags(userId, feedId, items);
}

/** Attach feed `<category>` tags to freshly upserted articles. */
async function attachFeedTags(
	userId: string,
	feedId: number,
	items: { guid: string; tags: string[] }[]
) {
	const withTags = items.filter((i) => (i.tags ?? []).length > 0);
	if (withTags.length === 0) return;
	const tagIds = new Map<string, number>();
	for (const item of withTags) {
		for (const raw of item.tags ?? []) {
			const name = normalizeFeedTags([raw])[0];
			if (!name || tagIds.has(name)) continue;
			const id = await ensureTag(userId, name);
			if (id) tagIds.set(name, id);
		}
	}
	if (tagIds.size === 0) return;
	const guids = withTags.map((i) => i.guid.slice(0, 500));
	const rows = await db
		.select({ id: article.id, guid: article.guid })
		.from(article)
		.where(and(eq(article.feedId, feedId), inArray(article.guid, guids)));
	const byGuid = new Map(rows.map((r) => [r.guid, r.id]));
	for (const item of withTags) {
		const articleId = byGuid.get(item.guid.slice(0, 500));
		if (!articleId) continue;
		for (const raw of item.tags ?? []) {
			const name = normalizeFeedTags([raw])[0];
			const tagId = name ? tagIds.get(name) : undefined;
			if (!tagId) continue;
			await db
				.insert(articleTag)
				.values({ tagId, articleId, source: 'feed' })
				.onConflictDoNothing({ target: [articleTag.tagId, articleTag.articleId] });
		}
	}
}

/**
 * Fetch a feed row for a refresh tick.
 *
 * - Normal rows fetch `buildFetchUrl(f)` as before.
 * - Placeholder rows (populateFeed never finished — transient add-time
 *   failure, RSSHub outage) re-run discovery so a pasted channel/page URL
 *   like `youtube.com/@t3dotgg` resolves to its RSSHub route instead of
 *   refetching an HTML page forever. On success the row is healed with the
 *   real title/site/icon and `healed: true` is returned so callers can run
 *   the feed-scoped backfills a missed populateFeed would have done.
 *
 * On failure the resolved URL (when discovery found one) is persisted so the
 * next tick retries the real feed target; the error propagates to the caller,
 * which logs it — the row is never deleted here.
 */
export async function fetchFeedForRefresh(
	f: typeof feed.$inferSelect,
	fetchFn: typeof fetchFeed = fetchFeed
): Promise<{ parsed: Awaited<ReturnType<typeof fetchFeed>>; healed: boolean }> {
	if (!isPlaceholderFeed(f)) {
		return { parsed: await fetchFn(buildFetchUrl(f)), healed: false };
	}
	const discovery = await discoverFeed(f.url);
	const url = discovery.url;
	const fromRsshub = isRsshubUrl(url);
	let rsshubRoute: string | null = null;
	if (fromRsshub) {
		try {
			rsshubRoute = new URL(url).pathname;
		} catch {
			rsshubRoute = null;
		}
	}
	let parsed: Awaited<ReturnType<typeof fetchFeed>>;
	try {
		parsed =
			discovery.parsed ??
			(await fetchFn(buildFetchUrl({ url, source: fromRsshub ? 'rsshub' : 'rss' })));
	} catch (e) {
		// Persist the resolved route even when the fetch failed so the next
		// tick skips straight to it; then surface the error to the caller.
		if (url !== f.url) {
			try {
				await db
					.update(feed)
					.set({ url, source: fromRsshub ? 'rsshub' : 'rss', rsshubRoute })
					.where(eq(feed.id, f.id));
			} catch (dbErr) {
				console.error(`could not persist discovered url for ${f.url}`, dbErr);
			}
		}
		throw e;
	}
	await db
		.update(feed)
		.set({
			url,
			title: parsed.title,
			siteUrl: parsed.siteUrl ?? f.siteUrl,
			imageUrl: parsed.imageUrl ?? f.imageUrl,
			source: fromRsshub ? 'rsshub' : 'rss',
			rsshubRoute,
			lastFetchedAt: new Date()
		})
		.where(eq(feed.id, f.id));
	return { parsed, healed: true };
}

/** Refresh only this user's feeds: each account fetches its own copies.
 *
 * Concurrency guard: page loads fire a background (non-forced) refresh on
 * almost every navigation (Today, collections, Read later), so rapid
 * clicking used to stack overlapping full refresh loops — serial network
 * fetches plus DB upserts competing with the foreground page queries on the
 * same event loop/pool, which read as a random multi-second hang. A second
 * call for the same user now joins the in-flight run, and background ticks
 * are throttled to one per minute (explicit Refresh / force bypasses both).
 */
const refreshInFlight = new Map<string, Promise<{ added: number }>>();
const lastBackgroundRefreshAt = new Map<string, number>();
const BACKGROUND_REFRESH_COOLDOWN_MS = 60_000;

/** Test-only: reset the refresh guard so tests can re-run refreshes. */
export function _resetRefreshGuardForTests(): void {
	refreshInFlight.clear();
	lastBackgroundRefreshAt.clear();
}

export async function refreshStaleFeeds(userId: string, force = false) {
	if (!force) {
		const now = Date.now();
		if (now - (lastBackgroundRefreshAt.get(userId) ?? 0) < BACKGROUND_REFRESH_COOLDOWN_MS) {
			return { added: 0 };
		}
		const running = refreshInFlight.get(userId);
		if (running) return running;
		lastBackgroundRefreshAt.set(userId, now);
		const run = refreshStaleFeedsInner(userId, false).finally(() => {
			if (refreshInFlight.get(userId) === run) refreshInFlight.delete(userId);
		});
		refreshInFlight.set(userId, run);
		return run;
	}
	return refreshStaleFeedsInner(userId, true);
}

async function refreshStaleFeedsInner(userId: string, force = false) {
	const feeds = await db.select().from(feed).where(eq(feed.userId, userId));
	let added = 0;
	for (const f of feeds) {
		if (!isFeedStale(f.lastFetchedAt, force)) continue;
		try {
			const { parsed, healed } = await fetchFeedForRefresh(f);
			const before = await db
				.select({ n: sql<number>`count(*)`.mapWith(Number) })
				.from(article)
				.where(eq(article.feedId, f.id));
			await upsertItems(f.id, parsed.items);
			const after = await db
				.select({ n: sql<number>`count(*)`.mapWith(Number) })
				.from(article)
				.where(eq(article.feedId, f.id));
			added += (after[0]?.n ?? 0) - (before[0]?.n ?? 0);
			if (healed) {
				// A formerly broken feed just populated for the first time:
				// give it the same immediate full-text/enrich pass populateFeed
				// gives a successful add. (fetchFeedForRefresh already wrote
				// lastFetchedAt/title/site/icon.)
				await backfillNewFeedItems(f.id);
			} else {
				// Backfill missing icons/URLs so old rows pick up favicons.
				await db
					.update(feed)
					.set({
						lastFetchedAt: new Date(),
						siteUrl: f.siteUrl ?? parsed.siteUrl ?? null,
						imageUrl: f.imageUrl ?? parsed.imageUrl ?? null
					})
					.where(eq(feed.id, f.id));
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			// Same backoff + quiet-log policy as the scheduler: stamp the
			// attempt so dead feeds wait out the stale window, warn once for
			// permanent failures, full error only for transient ones.
			try {
				await db.update(feed).set({ lastFetchedAt: new Date() }).where(eq(feed.id, f.id));
			} catch {
				// best-effort
			}
			if (isTransientFeedError(e)) {
				console.error(`refresh failed for ${f.url}`, e);
			} else {
				console.warn(`refresh skipped for ${f.url}: ${msg}`);
			}
		}
	}
	return { added };
}
