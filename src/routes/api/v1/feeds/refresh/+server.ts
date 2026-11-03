import type { RequestHandler } from './$types';
import { getRefreshIntervalMs, getSchedulerStatus } from '$lib/server/rss/scheduler';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, ok } from '$lib/server/api/respond';
import { refreshStaleFeeds } from '$lib/server/rss/refresh';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

export const GET: RequestHandler = async ({ request, locals }) => {
	const g = await guardApi(request, locals, { scope: 'read', bucket: 'feeds-refresh' });
	if ('response' in g) return g.response;
	return send(request, ok({ scheduler: getSchedulerStatus() }));
};

export const POST: RequestHandler = async ({ request, locals, url }) => {
	const g = await guardApi(request, locals, {
		scope: 'write',
		bucket: 'feeds-refresh',
		limit: 10
	});
	if ('response' in g) return g.response;
	const force = url.searchParams.get('force') === '1';
	try {
		const result = await refreshStaleFeeds(g.user.id, force);
		return send(
			request,
			ok({ ...result, intervalMs: getRefreshIntervalMs(), scheduler: getSchedulerStatus() })
		);
	} catch (e) {
		console.error('v1 feeds refresh failed', e);
		return send(request, apiError('refresh_failed', 'Refresh failed', 500));
	}
};
