import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, ok } from '$lib/server/api/respond';
import { parseIdParam } from '$lib/server/api/validate';
import {
	deleteCollection,
	renameCollection,
	updateSmartCollectionRules
} from '$lib/server/rss/refresh';
import { parseSmartRules } from '$lib/collections';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

export const PATCH: RequestHandler = async ({ request, locals, params }) => {
	const g = await guardApi(request, locals, { scope: 'write', bucket: 'collections' });
	if ('response' in g) return g.response;
	const id = parseIdParam(params.id);
	if (!id) return send(request, apiError('invalid_id', 'Invalid collection id', 422));
	let body: { name?: unknown; rules?: unknown };
	try {
		body = await request.json();
	} catch {
		return send(request, apiError('invalid_body', 'Body must be JSON', 422));
	}
	try {
		if (body.name !== undefined) {
			const name = String(body.name).trim();
			if (!name) return send(request, apiError('invalid_body', 'name must not be empty', 422));
			await renameCollection(g.user.id, id, name);
		}
		if (body.rules !== undefined) {
			const rules = parseSmartRules(body.rules);
			if (!rules) return send(request, apiError('invalid_body', 'Add at least one rule', 422));
			await updateSmartCollectionRules(g.user.id, id, rules);
		}
		if (body.name === undefined && body.rules === undefined)
			return send(request, apiError('invalid_body', 'Nothing to update', 422));
		return send(request, ok({ id }));
	} catch (e) {
		console.error('v1 collections update failed', e);
		return send(request, apiError('update_failed', 'Could not update collection', 400));
	}
};

export const DELETE: RequestHandler = async ({ request, locals, params }) => {
	const g = await guardApi(request, locals, { scope: 'write', bucket: 'collections' });
	if ('response' in g) return g.response;
	const id = parseIdParam(params.id);
	if (!id) return send(request, apiError('invalid_id', 'Invalid collection id', 422));
	try {
		await deleteCollection(g.user.id, id);
		return send(request, ok({ id }));
	} catch (e) {
		console.error('v1 collections delete failed', e);
		return send(
			request,
			apiError('delete_failed', e instanceof Error ? e.message : 'Could not delete collection', 400)
		);
	}
};
