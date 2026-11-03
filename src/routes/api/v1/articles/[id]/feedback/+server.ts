import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, ok } from '$lib/server/api/respond';
import { parseIdParam } from '$lib/server/api/validate';
import { logArticleEvent } from '$lib/server/rss/refresh';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

const KINDS = new Set(['dismiss', 'mute_feed', 'mute_topic']);

export const POST: RequestHandler = async ({ request, locals, params }) => {
	const g = await guardApi(request, locals, { scope: 'write', bucket: 'events' });
	if ('response' in g) return g.response;
	const id = parseIdParam(params.id);
	if (!id) return send(request, apiError('invalid_id', 'Invalid article id', 422));
	let body: { kind?: unknown };
	try {
		body = await request.json();
	} catch {
		return send(request, apiError('invalid_body', 'Body must be JSON', 422));
	}
	if (typeof body.kind !== 'string' || !KINDS.has(body.kind))
		return send(
			request,
			apiError('invalid_body', 'kind must be dismiss|mute_feed|mute_topic', 422)
		);
	try {
		await logArticleEvent(g.user.id, id, body.kind as 'dismiss' | 'mute_feed' | 'mute_topic');
	} catch (e) {
		console.error('v1 feedback failed', e);
		return send(request, apiError('feedback_failed', 'Could not save feedback', 500));
	}
	return send(request, ok({ id }));
};
