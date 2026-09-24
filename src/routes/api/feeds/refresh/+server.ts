import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { refreshStaleFeeds } from '$lib/server/rss/refresh';
import { getSchedulerStatus } from '$lib/server/rss/scheduler';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	return json({ ok: true, scheduler: getSchedulerStatus() });
};

export const POST: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const force = url.searchParams.get('force') === '1';
	const result = await refreshStaleFeeds(locals.user.id, force);
	return json({ ok: true, ...result });
};
