import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, ok } from '$lib/server/api/respond';
import { parseIdParam } from '$lib/server/api/validate';
import { isArticleEventKind, logArticleEvent } from '$lib/server/rss/refresh';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

export const POST: RequestHandler = async ({ request, locals, params }) => {
	const g = await guardApi(request, locals, { scope: 'write', bucket: 'events', limit: 120 });
	if ('response' in g) return g.response;
	const id = parseIdParam(params.id);
	if (!id) return send(request, apiError('invalid_id', 'Invalid article id', 422));
	let body: { kind?: unknown; value?: unknown };
	try {
		body = await request.json();
	} catch {
		return send(request, apiError('invalid_body', 'Body must be JSON', 422));
	}
	if (!isArticleEventKind(body.kind))
		return send(request, apiError('invalid_body', 'Invalid event kind', 422));
	const value = typeof body.value === 'number' ? body.value : 0;
	try {
		await logArticleEvent(g.user.id, id, body.kind, value);
	} catch (e) {
		console.error('v1 article event failed', e);
		return send(request, apiError('event_failed', 'Could not log event', 500));
	}
	return send(request, ok({ id }));
};
