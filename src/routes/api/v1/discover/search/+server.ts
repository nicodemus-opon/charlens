import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, ok } from '$lib/server/api/respond';
import { parseLimitParam } from '$lib/server/api/validate';
import { isUrlLike, searchDiscovery, type DiscoverSort } from '$lib/server/rss/discovery';
import { discoverAllSiteFeeds } from '$lib/server/rss/parser';
import { getRadarCandidates, radarDisplayName, resolveCandidateUrl } from '$lib/server/rss/rsshub';
import { parseLocale } from '$lib/server/rss/feed-search';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

function clampSort(value: string | null): DiscoverSort {
	return value === 'relevance' || value === 'az' ? value : 'best';
}

export const GET: RequestHandler = async ({ request, locals, url }) => {
	const g = await guardApi(request, locals, { scope: 'read', bucket: 'discover' });
	if ('response' in g) return g.response;
	const query = (url.searchParams.get('q') ?? '').trim().slice(0, 300);
	if (!query) return send(request, ok({ candidates: [] }));
	const limit = parseLimitParam(url.searchParams.get('limit'), 8, 25);
	const sort = clampSort(url.searchParams.get('sort'));
	const locale = parseLocale(request.headers.get('accept-language'));
	try {
		if (isUrlLike(query)) {
			const { candidates, failed } = await getRadarCandidates(query, { limit: 20 });
			const rows = candidates.map((c) => ({
				id: `${query}${c.routePath}`,
				routePath: c.routePath,
				title: radarDisplayName(c),
				url: resolveCandidateUrl(c) ?? '',
				needsParams: c.needsParams,
				subscribed: false
			}));
			try {
				const siteFeeds = await discoverAllSiteFeeds(query);
				const seen = new Set(rows.map((r) => r.url));
				for (const f of siteFeeds) {
					if (!f.url || seen.has(f.url)) continue;
					seen.add(f.url);
					rows.unshift({
						id: `site:${f.url}`,
						routePath: '',
						title: f.title || f.url,
						url: f.url,
						needsParams: false,
						subscribed: false
					});
				}
			} catch {
				// site-feed probing is best-effort
			}
			return send(request, ok({ candidates: rows.slice(0, limit), failed }));
		}
		const { candidates, failed, total } = await searchDiscovery(query, g.user.id, {
			limit,
			sort,
			lang: locale.lang,
			region: locale.region
		});
		return send(request, ok({ candidates, failed, total }));
	} catch (e) {
		console.error('v1 discover search failed', e);
		return send(request, apiError('search_failed', 'Search failed', 500));
	}
};
