import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isArticleEventKind, logArticleEvent } from '$lib/server/rss/refresh';

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) return json({ error: 'invalid id' }, { status: 400 });
	let body: { kind?: unknown; value?: unknown } = {};
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid body' }, { status: 400 });
	}
	if (!isArticleEventKind(body.kind)) return json({ error: 'invalid kind' }, { status: 400 });
	const value = typeof body.value === 'number' ? body.value : 0;
	try {
		await logArticleEvent(locals.user.id, id, body.kind, value);
	} catch (e) {
		console.error(`article event failed for ${id}`, e);
		return json({ error: 'event failed' }, { status: 500 });
	}
	return json({ ok: true, id });
};
