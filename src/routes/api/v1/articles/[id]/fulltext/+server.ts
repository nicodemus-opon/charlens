import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, notFound, ok } from '$lib/server/api/respond';
import { parseIdParam } from '$lib/server/api/validate';
import { fetchArticleFulltext } from '$lib/server/api/fulltext-service';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

export const POST: RequestHandler = async ({ request, locals, params, url }) => {
	const g = await guardApi(request, locals, { scope: 'write', bucket: 'fulltext', limit: 10 });
	if ('response' in g) return g.response;
	const id = parseIdParam(params.id);
	if (!id) return send(request, apiError('invalid_id', 'Invalid article id', 422));
	const result = await fetchArticleFulltext(g.user.id, id, {
		force: url.searchParams.get('force') === '1'
	});
	if (result.status === 'not_found') return send(request, notFound('Article not found'));
	if (result.status === 'failed')
		return send(request, apiError('scrape_failed', result.message, 502));
	return send(request, ok({ id: result.id, cached: result.cached }));
};
