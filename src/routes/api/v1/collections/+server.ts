import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, ok } from '$lib/server/api/respond';
import { createCollection, createSmartCollection, listCollections } from '$lib/server/rss/refresh';
import { parseSmartRules } from '$lib/collections';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

export const GET: RequestHandler = async ({ request, locals }) => {
	const g = await guardApi(request, locals, { scope: 'read', bucket: 'collections' });
	if ('response' in g) return g.response;
	try {
		return send(request, ok({ collections: await listCollections(g.user.id) }));
	} catch (e) {
		console.error('v1 collections list failed', e);
		return send(request, apiError('list_failed', 'Could not list collections', 500));
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	const g = await guardApi(request, locals, { scope: 'write', bucket: 'collections' });
	if ('response' in g) return g.response;
	let body: { name?: unknown; kind?: unknown; rules?: unknown };
	try {
		body = await request.json();
	} catch {
		return send(request, apiError('invalid_body', 'Body must be JSON', 422));
	}
	const name = String(body.name ?? '').trim();
	if (!name) return send(request, apiError('invalid_body', 'name is required', 422));
	try {
		if (body.kind === 'smart') {
			const rules = parseSmartRules(body.rules);
			if (!rules) return send(request, apiError('invalid_body', 'Add at least one rule', 422));
			const id = await createSmartCollection(g.user.id, name, rules);
			return send(request, ok({ id }, 201));
		}
		const id = await createCollection(g.user.id, name);
		return send(request, ok({ id }, 201));
	} catch (e) {
		console.error('v1 collections create failed', e);
		return send(request, apiError('create_failed', 'Could not create collection', 400));
	}
};
