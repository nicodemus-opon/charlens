import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, ok } from '$lib/server/api/respond';
import { parseLimitParam } from '$lib/server/api/validate';
import { getArticles } from '$lib/server/rss/refresh';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

/** Keyword lookup (title/excerpt/author) — no embeddings, safe per-keystroke. */
export const GET: RequestHandler = async ({ request, locals, url }) => {
	const g = await guardApi(request, locals, { scope: 'read', bucket: 'articles-search' });
	if ('response' in g) return g.response;
	const query = (url.searchParams.get('q') ?? '').trim();
	if (!query) return send(request, ok({ articles: [] }));
	try {
		const rows = await getArticles(g.user.id, {
			query,
			filter: 'all',
			limit: parseLimitParam(url.searchParams.get('limit'), 8, 25)
		});
		return send(
			request,
			ok({
				articles: rows.map((row) => ({
					id: row.id,
					title: row.title,
					feedTitle: row.feedTitle,
					link: row.link,
					publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
					isRead: row.isRead,
					isSaved: row.isSaved
				}))
			})
		);
	} catch (e) {
		console.error('v1 article search failed', e);
		return send(request, apiError('search_failed', 'Search failed', 500));
	}
};
