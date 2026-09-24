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
	userInterest
} from '$lib/server/db/feeds.schema';
import {
	buildAffinityMaps,
	canonicalTitleKey,
	deterministicExploreBoost,
	idfWeight,
	interactionWeight,
	keywordMatchBoost,
	rankWithMMR,
	scoreCandidate,
	SHUFFLE_EXPLORATION_MULTIPLIER,
	timeDecay,
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
	'impression' | 'open' | 'dwell' | 'scroll' | 'save' | 'share' | 'finish';

const EVENT_KINDS = new Set<string>([
	'impression',
	'open',
	'dwell',
	'scroll',
	'save',
	'share',
	'finish'
]);

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

export async function getArticles(
	userId: string,
	opts: {
		feedId?: number;
		collectionId?: number;
		tagId?: number;
		smart?: SmartRules;
		filter?: ArticleFilter;
		query?: string;
		limit?: number;
	}
) {
	const { feedId, collectionId, tagId, smart, filter = 'all', query, limit = 100 } = opts;
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

export async function toggleSaved(userId: string, articleId: number) {
	if (!(await canAccessArticle(userId, articleId))) return;
	const rows = await db
		.select({ isSaved: userArticleState.isSaved })
		.from(userArticleState)
		.where(and(eq(userArticleState.userId, userId), eq(userArticleState.articleId, articleId)))
		.limit(1);
	await upsertState(userId, articleId, { isSaved: !(rows[0]?.isSaved ?? false) });
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
	// model in the background so the next Recommended load re-ranks. Dwell
	// and scroll beacons are covered by the same throttle via open/finish.
	if (kind === 'open' || kind === 'finish') scheduleInterestRefresh(userId);
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
	for (const s of states) {
		const w =
			interactionWeight({
				openCount: s.openCount,
				isRead: s.isRead,
				isSaved: s.isSaved,
				finished: s.finished,
				totalDwellMs: s.totalDwellMs,
				maxScrollPct: s.maxScrollPct
			}) * timeDecay(now - (s.updatedAt?.getTime() ?? now));
		if (!(w > 0)) continue;
		feedCounts.set(s.feedId, (feedCounts.get(s.feedId) ?? 0) + w);
		if (s.author?.trim()) {
			const key = s.author.trim().toLowerCase();
			authorCounts.set(key, (authorCounts.get(key) ?? 0) + w);
		}
		const tags = tagByArticle.get(s.articleId) ?? [];
		if (tags.length > 0) {
			const share = w / tags.length;
			for (const t of tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + share);
		}
	}
	return buildAffinityMaps({ feedCounts, tagCounts, authorCounts });
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
				gte(article.publishedAt, since),
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
export async function getRecommendedArticles(
	userId: string,
	opts: { limit?: number; query?: string; feedId?: number; seed?: string | number } = {}
) {
	const { limit = 100, query, feedId, seed = '' } = opts;
	const trimmedQuery = query?.trim() ?? '';
	const isSearch = trimmedQuery.length > 0;
	// Semantic search: embed the query once, then rank the whole recent window
	// by cosine similarity instead of substring filtering. When the embedding
	// model is unavailable (keyword-only mode) fall back to the ilike filter.
	let queryVec: number[] | null = null;
	if (isSearch) {
		try {
			const { embedText } = await import('$lib/server/enrich/embeddings');
			queryVec = await embedText(trimmedQuery);
		} catch {
			queryVec = null;
		}
	}
	const since = new Date(Date.now() - 14 * 86400000);
	const conds = [
		eq(subscription.userId, userId),
		eq(feed.userId, userId),
		gte(article.publishedAt, since)
	];
	if (feedId) conds.push(eq(article.feedId, feedId));
	if (isSearch && !queryVec) {
		const q = `%${trimmedQuery}%`;
		conds.push(or(ilike(article.title, q), ilike(article.excerpt, q), ilike(article.author, q))!);
	}
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
		.orderBy(desc(sql`coalesce(${article.publishedAt}, ${article.createdAt})`), desc(article.id))
		.limit(500);

	const now = Date.now();
	const affinities = await getAffinityMaps(userId, now);
	// Cold-start users get chronological order — unless a semantic query
	// vector exists, in which case search ranking still works.
	if (!affinities.hasSignals && !queryVec) return rows.slice(0, limit);

	const candidateIds = rows.map((r) => r.id);
	const [tagMap, candidateStates, embeddingRows, interestRows] = await Promise.all([
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
					.limit(1)
	]);
	// A search query vector takes priority over the interest model: "what
	// I'm looking for right now" beats "what I generally read".
	const semanticTarget = queryVec ?? interestRows[0]?.embedding ?? null;
	const embeddingById = new Map(embeddingRows.map((e) => [e.articleId, e]));
	const stateById = new Map(candidateStates.map((s) => [s.articleId, s]));

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

	// Feed volume normalization: a feed with 40 recent items shouldn't
	// auto-win over a quiet feed the user loves equally.
	const feedVolume = new Map<number, number>();
	for (const r of rows) feedVolume.set(r.feedId, (feedVolume.get(r.feedId) ?? 0) + 1);
	for (const [fid, count] of feedVolume) {
		const cur = affinities.feedScores.get(fid);
		if (cur != null && count > 1) affinities.feedScores.set(fid, cur / Math.log2(1 + count));
	}

	const mode = isSearch ? 'search' : 'recommend';
	const scored = rows.map((r) => {
		const st = stateById.get(r.id);
		const stored = embeddingById.get(r.id);
		const s = scoreCandidate(
			{
				id: r.id,
				feedId: r.feedId,
				author: r.author,
				publishedAt: r.publishedAt,
				isRead: r.isRead,
				isSaved: r.isSaved,
				tags: tagsPerRow.get(r.id) ?? [],
				semanticSimilarity: similarityToInterest(stored?.embedding, semanticTarget),
				finished: st?.finished ?? false,
				dwellMs: st?.totalDwellMs ?? null,
				scrollPct: st?.maxScrollPct ?? null,
				hasImage: !!r.imageUrl,
				excerptLength: r.excerpt?.length ?? 0,
				titleLength: r.title?.length ?? 0
			},
			affinities,
			{
				now,
				mode,
				tagIdf,
				keywordBoost: isSearch ? keywordMatchBoost(trimmedQuery, r) : 0,
				// An explicit shuffle seed amplifies the exploration slot so the
				// reshuffle is visible; without a seed the base weight applies.
				explorationBoost:
					deterministicExploreBoost(userId, r.id, now, isSearch ? '' : seed) *
					(!isSearch && seed ? SHUFFLE_EXPLORATION_MULTIPLIER : 1)
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
		void db
			.insert(recommendScoreLog)
			.values(
				scored.slice(0, limit).map((s) => ({
					userId,
					articleId: s.id,
					score: s.score,
					components: s.components
				}))
			)
			.catch((e) => console.error('recommend score log failed', e));
	}
	const orderedIds = rankWithMMR(scored);
	const byId = new Map(rows.map((r) => [r.id, r]));
	return orderedIds
		.map((id) => byId.get(id))
		.filter((r) => r != null)
		.slice(0, limit);
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

/** Refresh only this user's feeds: each account fetches its own copies. */
export async function refreshStaleFeeds(userId: string, force = false) {
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
			console.error(`refresh failed for ${f.url}`, e);
		}
	}
	return { added };
}
