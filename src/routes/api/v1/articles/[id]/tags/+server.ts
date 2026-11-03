import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, notFound, ok } from '$lib/server/api/respond';
import { parseIdParam } from '$lib/server/api/validate';
import { getArticleById, getArticleTags, setArticleTags } from '$lib/server/rss/refresh';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

export const GET: RequestHandler = async ({ request, locals, params }) => {
	const g = await guardApi(request, locals, { scope: 'read', bucket: 'articles' });
	if ('response' in g) return g.response;
	const id = parseIdParam(params.id);
	if (!id) return send(request, apiError('invalid_id', 'Invalid article id', 422));
	if (!(await getArticleById(g.user.id, id))) return send(request, notFound('Article not found'));
	return send(request, ok({ tags: await getArticleTags(g.user.id, id) }));
};

export const PUT: RequestHandler = async ({ request, locals, params }) => {
	const g = await guardApi(request, locals, { scope: 'write', bucket: 'articles' });
	if ('response' in g) return g.response;
	const id = parseIdParam(params.id);
	if (!id) return send(request, apiError('invalid_id', 'Invalid article id', 422));
	if (!(await getArticleById(g.user.id, id))) return send(request, notFound('Article not found'));
	let body: { tags?: unknown };
	try {
		body = await request.json();
	} catch {
		return send(request, apiError('invalid_body', 'Body must be JSON', 422));
	}
	const tags = Array.isArray(body.tags)
		? body.tags.map(String).join(', ')
		: typeof body.tags === 'string'
			? body.tags
			: null;
	if (tags == null)
		return send(request, apiError('invalid_body', 'tags must be string[] or string', 422));
	await setArticleTags(g.user.id, id, tags);
	return send(request, ok({ tags: await getArticleTags(g.user.id, id) }));
};
