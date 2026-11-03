import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, ok } from '$lib/server/api/respond';
import { listTags } from '$lib/server/rss/refresh';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

export const GET: RequestHandler = async ({ request, locals }) => {
	const g = await guardApi(request, locals, { scope: 'read', bucket: 'tags' });
	if ('response' in g) return g.response;
	try {
		return send(request, ok({ tags: await listTags(g.user.id) }));
	} catch (e) {
		console.error('v1 tags list failed', e);
		return send(request, apiError('list_failed', 'Could not list tags', 500));
	}
};
