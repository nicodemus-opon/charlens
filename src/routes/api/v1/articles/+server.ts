import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, ok } from '$lib/server/api/respond';
import {
	parseCursor,
	parseFilter,
	parseLimitParam,
	parseOptionalInt,
	invalidFilter
} from '$lib/server/api/validate';
import {
	getArticles,
	getRecommendedArticles,
	getSmartRules,
	getTagsForArticles
} from '$lib/server/rss/refresh';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

function toIso(d: Date | null | undefined): string | null {
	return d ? d.toISOString() : null;
}

/**
 * GET /api/v1/articles — cursor is an offset into the ordered list
 * (`nextCursor` null = exhausted). Lists are excerpt-only; fetch one article
 * for `contentHtml`.
 */
export const GET: RequestHandler = async ({ request, locals, url }) => {
	const g = await guardApi(request, locals, { scope: 'read', bucket: 'articles' });
	if ('response' in g) return g.response;

	const rawFilter = url.searchParams.get('filter') ?? 'all';
	const filter = parseFilter(rawFilter);
	if (!filter) return send(request, apiError('invalid_filter', invalidFilter(), 422));
	const feedId = parseOptionalInt(url.searchParams.get('feedId') ?? url.searchParams.get('feed'));
	const collectionId = parseOptionalInt(
		url.searchParams.get('collectionId') ?? url.searchParams.get('collection')
	);
	const tagId = parseOptionalInt(url.searchParams.get('tagId') ?? url.searchParams.get('tag'));
	const viewId = parseOptionalInt(url.searchParams.get('viewId') ?? url.searchParams.get('view'));
	const query = url.searchParams.get('q') ?? '';
	const seed = url.searchParams.get('seed') ?? '';
	const deep = url.searchParams.get('deep') === '1';
	const limit = parseLimitParam(url.searchParams.get('limit'));
	const cursor = parseCursor(url.searchParams.get('cursor')) ?? 0;

	// Service layers page by limit only — over-fetch then slice for the offset
	// cursor. Caps keep worst-case at ~500 rows on a self-hosted box.
	const fetchLimit = Math.min(500, cursor + limit);
	try {
		const smart = viewId ? await getSmartRules(g.user.id, viewId) : null;
		if (viewId && !smart) return send(request, apiError('not_found', 'Smart view not found', 404));
		const useRecommended =
			!collectionId && !tagId && !smart && (filter === 'recommended' || query.trim() !== '');
		const rows = useRecommended
			? await getRecommendedArticles(g.user.id, {
					feedId,
					query,
					limit: fetchLimit,
					seed,
					deep
				})
			: await getArticles(g.user.id, {
					feedId,
					collectionId,
					tagId,
					smart: smart ?? undefined,
					filter: filter === 'recommended' ? 'all' : (filter as 'today' | 'saved' | 'all'),
					query,
					limit: fetchLimit
				});
		const tagMap = await getTagsForArticles(
			g.user.id,
			rows.map((a) => a.id)
		);
		const page = rows.slice(cursor, cursor + limit).map((a) => ({
			id: a.id,
			feedId: a.feedId,
			feedTitle: a.feedTitle,
			title: a.title,
			link: a.link,
			author: a.author,
			publishedAt: toIso(a.publishedAt),
			excerpt: a.excerpt,
			imageUrl: a.imageUrl,
			isRead: a.isRead,
			isSaved: a.isSaved,
			tags: tagMap.get(a.id) ?? []
		}));
		const nextCursor = cursor + page.length < rows.length ? cursor + page.length : null;
		return send(request, ok({ articles: page, nextCursor }));
	} catch (e) {
		console.error('v1 articles list failed', e);
		return send(request, apiError('list_failed', 'Could not list articles', 500));
	}
};
