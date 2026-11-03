import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, ok } from '$lib/server/api/respond';
import { parseIdParam } from '$lib/server/api/validate';
import { moveFeed } from '$lib/server/rss/refresh';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

export const POST: RequestHandler = async ({ request, locals, params }) => {
	const g = await guardApi(request, locals, { scope: 'write', bucket: 'feeds' });
	if ('response' in g) return g.response;
	const feedId = parseIdParam(params.id);
	if (!feedId) return send(request, apiError('invalid_id', 'Invalid feed id', 422));
	let body: { collectionId?: unknown };
	try {
		body = await request.json();
	} catch {
		return send(request, apiError('invalid_body', 'Body must be JSON', 422));
	}
	const collectionId = parseIdParam(body.collectionId == null ? null : String(body.collectionId));
	if (!collectionId)
		return send(request, apiError('invalid_body', 'collectionId is required', 422));
	try {
		await moveFeed(g.user.id, feedId, collectionId);
		return send(request, ok({ id: feedId, collectionId }));
	} catch (e) {
		console.error('v1 feeds move failed', e);
		return send(request, apiError('move_failed', 'Could not move feed', 400));
	}
};
