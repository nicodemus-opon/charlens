import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getArticles } from '$lib/server/rss/refresh';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;

function clampLimit(value: string | null): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

/**
 * Article lookup for the ⌘K palette.
 *
 * Keyword match (title/excerpt/author) across the user's whole library — the
 * palette fires on every keystroke, so it deliberately stays off the semantic
 * path (`getRecommendedArticles` embeds the query, which is too heavy here).
 *
 * GET /api/articles/search?q=lens&limit=8
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const query = (url.searchParams.get('q') ?? '').trim();
	if (!query) return json({ articles: [] });
	try {
		const rows = await getArticles(locals.user.id, {
			query,
			// 'all' (not the default 'today') so the palette can reach back
			// past the last 24 hours.
			filter: 'all',
			limit: clampLimit(url.searchParams.get('limit'))
		});
		return json({
			articles: rows.map((row) => ({
				id: row.id,
				title: row.title,
				feedTitle: row.feedTitle,
				link: row.link,
				publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
				isRead: row.isRead,
				isSaved: row.isSaved
			}))
		});
	} catch (e) {
		console.error('article search failed', e);
		return json({ error: 'search failed' }, { status: 500 });
	}
};
