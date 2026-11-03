import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, notFound, ok } from '$lib/server/api/respond';
import { parseIdParam } from '$lib/server/api/validate';
import { getFeedsWithCounts, unsubscribe } from '$lib/server/rss/refresh';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

export const GET: RequestHandler = async ({ request, locals, params }) => {
	const g = await guardApi(request, locals, { scope: 'read', bucket: 'feeds' });
	if ('response' in g) return g.response;
	const id = parseIdParam(params.id);
	if (!id) return send(request, apiError('invalid_id', 'Invalid feed id', 422));
	const feeds = await getFeedsWithCounts(g.user.id);
	const feed = feeds.find((f) => f.id === id);
	if (!feed) return send(request, notFound('Feed not found'));
	return send(request, ok({ feed }));
};

export const DELETE: RequestHandler = async ({ request, locals, params }) => {
	const g = await guardApi(request, locals, { scope: 'write', bucket: 'feeds' });
	if ('response' in g) return g.response;
	const id = parseIdParam(params.id);
	if (!id) return send(request, apiError('invalid_id', 'Invalid feed id', 422));
	try {
		await unsubscribe(g.user.id, id);
		return send(request, ok({ id }));
	} catch (e) {
		console.error('v1 feeds delete failed', e);
		return send(request, apiError('delete_failed', 'Could not remove feed', 400));
	}
};
