import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isUrlLike, searchDiscovery, type DiscoverSort } from '$lib/server/rss/discovery';
import { discoverAllSiteFeeds } from '$lib/server/rss/parser';
import { getRadarCandidates, radarDisplayName, resolveCandidateUrl } from '$lib/server/rss/rsshub';
import { parseLocale } from '$lib/server/rss/feed-search';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;

function clampLimit(value: string | null): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

function clampSort(value: string | null): DiscoverSort {
	return value === 'relevance' || value === 'az' ? value : 'best';
}

function toJson(c: {
	id: string;
	routePath: string;
	title: string;
	namespace: string;
	domain: string;
	docs?: string;
	url: string;
	needsParams: boolean;
	score: number;
	subscribed: boolean;
}) {
	return c;
}

/**
 * Live discovery lookup for the Discover page search box.
 *
 * Keyword queries hit the interest-ranked web publisher search; URL-like
 * queries return radar candidates. Deliberately keyword-only (no per-keystroke
 * embeddings) — same rationale as the ⌘K article search.
 *
 * GET /api/discover/search?q=kenya&limit=8&sort=best
 */
export const GET: RequestHandler = async ({ url, locals, request }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const query = (url.searchParams.get('q') ?? '').trim().slice(0, 300);
	if (!query) return json({ candidates: [] });
	const limit = clampLimit(url.searchParams.get('limit'));
	const sort = clampSort(url.searchParams.get('sort'));
	const locale = parseLocale(request.headers.get('accept-language'));
	try {
		if (isUrlLike(query)) {
			const { candidates, failed } = await getRadarCandidates(query, { limit: 20 });
			const rows = candidates.map((c) =>
				toJson({
					id: `${query}${c.routePath}`,
					routePath: c.routePath,
					title: radarDisplayName(c),
					namespace: c.routePath.split('/').filter(Boolean)[0]?.toLowerCase() ?? '',
					domain: query,
					docs: c.docs,
					url: resolveCandidateUrl(c) ?? '',
					needsParams: c.needsParams,
					score: 1,
					subscribed: false
				})
			);
			// Native site feeds (declared, well-known, curated) so a pasted
			// site root lists each section feed, not just Radar routes.
			try {
				const siteFeeds = await discoverAllSiteFeeds(query);
				const seen = new Set(rows.map((r) => r.url));
				for (const f of siteFeeds) {
					if (!f.url || seen.has(f.url)) continue;
					seen.add(f.url);
					let feedHost = query;
					try {
						feedHost = new URL(f.url).hostname;
					} catch {
						// keep raw query as label
					}
					rows.unshift(
						toJson({
							id: `site:${f.url}`,
							routePath: '',
							title: f.title || f.url,
							namespace: 'rss',
							domain: feedHost,
							url: f.url,
							needsParams: false,
							score: 1.5,
							subscribed: false
						})
					);
				}
			} catch {
				// site-feed probing is best-effort; radar rows still return
			}
			return json({ candidates: rows.slice(0, limit), failed });
		}
		const { candidates, failed, total } = await searchDiscovery(query, locals.user.id, {
			limit,
			sort,
			lang: locale.lang,
			region: locale.region
		});
		return json({ candidates: candidates.map(toJson), failed, total });
	} catch (e) {
		console.error('discover search failed', e);
		return json({ error: 'search failed' }, { status: 500 });
	}
};
