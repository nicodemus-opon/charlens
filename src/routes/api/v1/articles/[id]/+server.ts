import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, notFound, ok } from '$lib/server/api/respond';
import { parseIdParam } from '$lib/server/api/validate';
import { getArticleById, getArticleTags, markRead } from '$lib/server/rss/refresh';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

export const GET: RequestHandler = async ({ request, locals, params }) => {
	const g = await guardApi(request, locals, { scope: 'read', bucket: 'articles' });
	if ('response' in g) return g.response;
	const id = parseIdParam(params.id);
	if (!id) return send(request, apiError('invalid_id', 'Invalid article id', 422));
	const row = await getArticleById(g.user.id, id);
	if (!row) return send(request, notFound('Article not found'));
	const tags = await getArticleTags(g.user.id, id);
	return send(
		request,
		ok({
			article: {
				...row,
				publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
				tags
			}
		})
	);
};

/** Idempotent state set (unlike the UI toggle): `{ isRead?, isSaved? }`. */
export const PATCH: RequestHandler = async ({ request, locals, params }) => {
	const g = await guardApi(request, locals, { scope: 'write', bucket: 'articles' });
	if ('response' in g) return g.response;
	const id = parseIdParam(params.id);
	if (!id) return send(request, apiError('invalid_id', 'Invalid article id', 422));
	let body: { isRead?: unknown; isSaved?: unknown };
	try {
		body = await request.json();
	} catch {
		return send(request, apiError('invalid_body', 'Body must be JSON', 422));
	}
	const patch: { isRead?: boolean; isSaved?: boolean } = {};
	if (body.isRead !== undefined) {
		if (typeof body.isRead !== 'boolean')
			return send(request, apiError('invalid_body', 'isRead must be boolean', 422));
		patch.isRead = body.isRead;
	}
	if (body.isSaved !== undefined) {
		if (typeof body.isSaved !== 'boolean')
			return send(request, apiError('invalid_body', 'isSaved must be boolean', 422));
		patch.isSaved = body.isSaved;
	}
	if (Object.keys(patch).length === 0)
		return send(request, apiError('invalid_body', 'Nothing to update', 422));
	const existing = await getArticleById(g.user.id, id);
	if (!existing) return send(request, notFound('Article not found'));
	const { toggleSaved } = await import('$lib/server/rss/refresh');
	if (patch.isRead !== undefined) await markRead(g.user.id, id, patch.isRead);
	if (patch.isSaved !== undefined && patch.isSaved !== existing.isSaved)
		await toggleSaved(g.user.id, id);
	const updated = await getArticleById(g.user.id, id);
	return send(
		request,
		ok({
			article: updated
				? {
						...updated,
						publishedAt: updated.publishedAt ? updated.publishedAt.toISOString() : null
					}
				: null
		})
	);
};
