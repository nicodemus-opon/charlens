import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { feed, userFeedback } from '$lib/server/db/feeds.schema';
import { isFeedSearchEnabled, searchPublishers } from './feed-search';
import { quickVerifyFeed, type QuickVerifyResult } from './parser';
import { getFeedsWithCounts, listTags } from './refresh';

export type DiscoverSort = 'best' | 'relevance' | 'az';

export interface DiscoverCandidate {
	/** Stable key. */
	id: string;
	/** RSSHub route path when the candidate is a route, else ''. */
	routePath: string;
	title: string;
	/** Source grouping (`web` for publisher results, route namespace otherwise). */
	namespace: string;
	/** Publisher/source domain (e.g. `citizen.digital`). */
	domain: string;
	docs?: string;
	/** Directly subscribable feed URL, or '' when params are still missing. */
	url: string;
	needsParams: boolean;
	prefill?: Record<string, string>;
	/** Interest-rank score (higher = better match for this user). */
	score: number;
	/** True when the user already follows this route. */
	subscribed: boolean;
	/** True when muted via feedback (filtered by callers, flagged for tests). */
	muted: boolean;
}

export interface DiscoveryContext {
	tagNames: string[];
	feedTitles: string[];
	subscribedTargets: Set<string>;
	/** Lowercased feed hosts the user already follows (for web candidates). */
	subscribedHosts: Set<string>;
	mutedTopics: Set<string>;
	mutedRoutes: Set<string>;
}

/** True when the query looks like a site/feed URL rather than a keyword. */
export function isUrlLike(query: string): boolean {
	const q = query.trim();
	if (!q || /\s/.test(q)) return false;
	if (/^https?:\/\//i.test(q)) return true;
	// bare domain or domain + path (requires a dot + short TLD-ish tail)
	return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(q) && q.length <= 500;
}

/**
 * Contiguous-phrase match on token boundaries (so `aily` doesn't match
 * `daily`, but `ai security` matches `ai security newsletter` and CJK
 * phrases match anywhere outside alphanumerics). Pure (tests).
 */
export function includesPhrase(haystack: string, phrase: string): boolean {
	const q = phrase.trim().toLowerCase();
	if (q.length === 0) return false;
	const hay = haystack.toLowerCase();
	let idx = hay.indexOf(q);
	while (idx >= 0) {
		const before = idx === 0 ? '' : hay[idx - 1];
		const after = idx + q.length >= hay.length ? '' : hay[idx + q.length];
		const boundary = (ch: string) => ch === '' || !/[a-z0-9]/.test(ch);
		if (boundary(before) && boundary(after)) return true;
		idx = hay.indexOf(q, idx + 1);
	}
	return false;
}
/**
 * Token overlap between a query and a haystack (0..1). Tokens are whole
 * words — unlike raw substring search this won't match `ai` inside `daily`.
 * A haystack token counts when it equals the query token or starts with it
 * (`sec` matches `security`). Pure (tests).
 */
export function tokenOverlap(query: string, haystack: string): number {
	const qTokens = query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length >= 2);
	if (qTokens.length === 0) return 0;
	const hayTokens = new Set(
		haystack
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((t) => t.length >= 2)
	);
	if (hayTokens.size === 0) return 0;
	let matched = 0;
	for (const q of qTokens) {
		for (const h of hayTokens) {
			if (h === q || h.startsWith(q)) {
				matched += 1;
				break;
			}
		}
	}
	return matched / qTokens.length;
}
/**
 * Interest-rank discovery candidates for a user. Blends token overlap
 * (query ↔ title/route) with tag overlap (user's tag names ↔
 * title/route/namespace) so niche tastes outrank generic matches.
 * Subscribed rows sink to the bottom (callers may hide them); muted rows
 * are flagged, never removed here. Pure (tests).
 */
export function rankCandidates(
	candidates: DiscoverCandidate[],
	query: string,
	ctx: DiscoveryContext,
	sort: DiscoverSort = 'best'
): DiscoverCandidate[] {
	const tagNames = ctx.tagNames.map((t) => t.toLowerCase()).filter((t) => t.length >= 2);
	const scored = candidates.map((c) => {
		const hay = `${c.title} ${c.routePath} ${c.namespace} ${c.domain}`;
		const keyword01 = tokenOverlap(query, hay);
		const tagHay = `${c.title} ${c.routePath} ${c.namespace}`;
		let tagHits = 0;
		for (const t of tagNames) {
			if (tokenOverlap(t, tagHay) > 0) tagHits += 1;
		}
		const tagScore = Math.min(1, tagHits / 2);
		const base =
			sort === 'az' ? 0 : sort === 'relevance' ? keyword01 : keyword01 * 0.7 + tagScore * 0.3;
		const score = c.subscribed ? base - 1 : base;
		return { ...c, score };
	});
	if (sort === 'az') return scored.sort((a, b) => a.title.localeCompare(b.title));
	return scored.sort((a, b) => b.score - a.score);
}

export function sortCandidates(
	candidates: DiscoverCandidate[],
	sort: DiscoverSort
): DiscoverCandidate[] {
	if (sort === 'az') return [...candidates].sort((a, b) => a.title.localeCompare(b.title));
	return [...candidates].sort((a, b) => b.score - a.score);
}

/** Per-user interest context for ranking + mute/subscription filtering. */
export async function getDiscoveryContext(userId: string): Promise<DiscoveryContext> {
	let tagNames: string[] = [];
	let feedTitles: string[] = [];
	const subscribedTargets = new Set<string>();
	const subscribedHosts = new Set<string>();
	try {
		const tags = await listTags(userId);
		// Most-used first so "Browse by your topics" surfaces real interests,
		// not alphabetical junk (a-z singletons). Tie-break A–Z for stability.
		tags.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name));
		tagNames = tags.map((t) => t.name);
	} catch (e) {
		console.error('discover tags load failed', e);
	}
	try {
		const feeds = await getFeedsWithCounts(userId);
		for (const f of feeds) {
			feedTitles.push(f.title);
		}
		// Subscribed RSSHub route paths (compare against candidate routePath).
		const rows = await db.select({ url: feed.url }).from(feed).where(eq(feed.userId, userId));
		for (const r of rows) {
			try {
				const u = new URL(r.url);
				subscribedHosts.add(u.hostname.toLowerCase());
				if (u.searchParams.has('format') || u.pathname.split('/').length > 2) {
					subscribedTargets.add(u.pathname);
				}
			} catch {
				// ignore non-URL rows
			}
		}
	} catch (e) {
		console.error('discover feeds load failed', e);
	}
	const mutedTopics = new Set<string>();
	const mutedRoutes = new Set<string>();
	try {
		const rows = await db
			.select({ kind: userFeedback.kind, topic: userFeedback.topic })
			.from(userFeedback)
			.where(eq(userFeedback.userId, userId));
		for (const r of rows) {
			if (r.kind === 'mute_topic' && r.topic) mutedTopics.add(r.topic.toLowerCase());
		}
	} catch (e) {
		console.error('discover feedback load failed', e);
	}
	if (mutedTopics.size > 0) {
		tagNames = tagNames.filter((t) => !mutedTopics.has(t.toLowerCase()));
	}
	return { tagNames, feedTitles, subscribedTargets, subscribedHosts, mutedTopics, mutedRoutes };
}

/**
 * Keyword → publisher sites currently writing about it (keyless web
 * search). Returns direct (site-root) candidates — feed verification
 * happens lazily in Preview/Follow. Never throws.
 */
export async function searchWebFeeds(
	query: string,
	ctx: DiscoveryContext,
	opts: { limit?: number; lang?: string; region?: string } = {}
): Promise<{ candidates: DiscoverCandidate[]; failed: boolean }> {
	const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
	if (!isFeedSearchEnabled()) return { candidates: [], failed: false };
	try {
		const { sites, failed } = await searchPublishers(query, {
			limit,
			lang: opts.lang,
			region: opts.region
		});
		// Publishers whose name matches the query rank first (e.g.
		// "TechCrunch" for "tech"); the rest keep Google's order.
		const scored = sites.map((s) => ({ s, rel: tokenOverlap(query, s.name) }));
		scored.sort((a, b) => b.rel - a.rel);
		const out: DiscoverCandidate[] = [];
		for (const { s } of scored) {
			let host = '';
			try {
				host = new URL(s.siteUrl).hostname.toLowerCase();
			} catch {
				continue;
			}
			const id = `web:${s.siteUrl}`;
			const subscribed = ctx.subscribedHosts.has(host);
			const muted = [...ctx.mutedTopics].some(
				(t) => t !== '' && (s.name.toLowerCase().includes(t) || host.includes(t))
			);
			if (muted) continue;
			out.push({
				id,
				routePath: '',
				title: s.name,
				namespace: 'web',
				domain: host,
				url: s.siteUrl,
				needsParams: false,
				score: 0,
				subscribed,
				muted: false
			});
			if (out.length >= limit) break;
		}
		return { candidates: out, failed };
	} catch (e) {
		console.error('web feed search failed', e);
		return { candidates: [], failed: true };
	}
}

const VERIFY_CACHE_MS = 24 * 60 * 60 * 1000;
const VERIFY_CONCURRENCY = 8;
const verifyCache = new Map<string, { at: number; result: QuickVerifyResult }>();

/**
 * Bulk feed-existence check for discovery cards: verified feed URL per
 * candidate id. Concurrency-capped, 24h cached, never throws. Callers pass
 * the returned promise through SvelteKit streaming so the page renders
 * first and cards flip states as verification lands.
 */
export async function verifyWebFeeds(
	items: { id: string; siteUrl: string }[]
): Promise<Record<string, QuickVerifyResult>> {
	const out: Record<string, QuickVerifyResult> = {};
	const now = Date.now();
	const pending: { id: string; siteUrl: string }[] = [];
	for (const item of items) {
		const cached = verifyCache.get(item.siteUrl);
		if (cached && now - cached.at < VERIFY_CACHE_MS) {
			out[item.id] = cached.result;
		} else {
			pending.push(item);
		}
	}
	for (let i = 0; i < pending.length; i += VERIFY_CONCURRENCY) {
		const batch = pending.slice(i, i + VERIFY_CONCURRENCY);
		const results = await Promise.all(
			batch.map(async (item) => {
				try {
					return await quickVerifyFeed(item.siteUrl);
				} catch {
					return { status: 'retry' } satisfies QuickVerifyResult;
				}
			})
		);
		batch.forEach((item, n) => {
			const result = results[n] ?? { status: 'retry' as const };
			verifyCache.set(item.siteUrl, { at: Date.now(), result });
			out[item.id] = result;
		});
	}
	return out;
}

/** Test-only: reset the verification cache. */
export function _resetVerifyCache() {
	verifyCache.clear();
}

/**
 * Keyword search over the keyless web publisher search (Google News RSS).
 * No RSSHub catalog — its routes skewed non-English and polluted topic
 * queries. Returns ranked candidates (muted excluded) plus outage info.
 * Never throws.
 */
export async function searchDiscovery(
	query: string,
	userId: string,
	opts: { limit?: number; sort?: DiscoverSort; lang?: string; region?: string } = {}
): Promise<{ candidates: DiscoverCandidate[]; failed: boolean; total: number }> {
	const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
	const sort = opts.sort ?? 'best';
	const ctx = await getDiscoveryContext(userId);
	const web = await searchWebFeeds(query, ctx, {
		limit,
		lang: opts.lang,
		region: opts.region
	});
	const ranked = rankCandidates(
		web.candidates.filter((c) => !c.muted),
		query,
		ctx,
		sort
	);
	return { candidates: ranked.slice(0, limit), failed: web.failed, total: ranked.length };
}
