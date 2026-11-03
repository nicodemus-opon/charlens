import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, ok } from '$lib/server/api/respond';
import { parseIdParam } from '$lib/server/api/validate';
import { deleteTag, renameTag } from '$lib/server/rss/refresh';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

export const PATCH: RequestHandler = async ({ request, locals, params }) => {
	const g = await guardApi(request, locals, { scope: 'write', bucket: 'tags' });
	if ('response' in g) return g.response;
	const id = parseIdParam(params.id);
	if (!id) return send(request, apiError('invalid_id', 'Invalid tag id', 422));
	let body: { name?: unknown };
	try {
		body = await request.json();
	} catch {
		return send(request, apiError('invalid_body', 'Body must be JSON', 422));
	}
	const name = String(body.name ?? '').trim();
	if (!name) return send(request, apiError('invalid_body', 'name is required', 422));
	try {
		await renameTag(g.user.id, id, name);
		return send(request, ok({ id }));
	} catch (e) {
		console.error('v1 tags rename failed', e);
		return send(request, apiError('rename_failed', 'Could not rename tag', 400));
	}
};

export const DELETE: RequestHandler = async ({ request, locals, params }) => {
	const g = await guardApi(request, locals, { scope: 'write', bucket: 'tags' });
	if ('response' in g) return g.response;
	const id = parseIdParam(params.id);
	if (!id) return send(request, apiError('invalid_id', 'Invalid tag id', 422));
	try {
		await deleteTag(g.user.id, id);
		return send(request, ok({ id }));
	} catch (e) {
		console.error('v1 tags delete failed', e);
		return send(request, apiError('delete_failed', 'Could not delete tag', 400));
	}
};
