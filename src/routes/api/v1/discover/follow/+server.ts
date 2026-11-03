import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, ok } from '$lib/server/api/respond';
import { addFeed, populateFeed } from '$lib/server/rss/refresh';
import { resolveCandidateUrl } from '$lib/server/rss/rsshub';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

/** Follow a feed: `{ url }` or `{ routePath, prefill? }` + optional `collection`. */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const g = await guardApi(request, locals, {
		scope: 'write',
		bucket: 'discover-follow',
		limit: 10
	});
	if ('response' in g) return g.response;
	let body: { url?: unknown; routePath?: unknown; prefill?: unknown; collection?: unknown };
	try {
		body = await request.json();
	} catch {
		return send(request, apiError('invalid_body', 'Body must be JSON', 422));
	}
	let feedUrl = typeof body.url === 'string' ? body.url.trim() : '';
	if (!feedUrl && typeof body.routePath === 'string' && body.routePath.trim()) {
		let prefill: Record<string, string> | undefined;
		if (body.prefill !== undefined) {
			if (!body.prefill || typeof body.prefill !== 'object' || Array.isArray(body.prefill))
				return send(request, apiError('invalid_body', 'prefill must be an object', 422));
			prefill = body.prefill as Record<string, string>;
		}
		const resolved = resolveCandidateUrl({ routePath: body.routePath.trim(), url: '', prefill });
		if (!resolved) return send(request, apiError('invalid_body', 'This route needs details', 422));
		feedUrl = resolved;
	}
	if (!feedUrl) return send(request, apiError('invalid_body', 'url or routePath is required', 422));
	try {
		new URL(feedUrl);
	} catch {
		return send(request, apiError('invalid_body', 'url must be a valid URL', 422));
	}
	const rawCollection = body.collection ?? 'General';
	const collectionRef =
		typeof rawCollection === 'number' && Number.isInteger(rawCollection) && rawCollection > 0
			? rawCollection
			: String(rawCollection).trim() || 'General';
	try {
		const feedId = await addFeed(g.user.id, feedUrl, collectionRef);
		const background = () => populateFeed(feedId, feedUrl);
		const waiter = (
			platform as { context?: { waitUntil?: (p: Promise<unknown>) => void } } | undefined
		)?.context?.waitUntil;
		if (waiter) waiter(background());
		else setTimeout(() => void background(), 0);
		return send(request, ok({ id: feedId, status: 'provisioning' }, 202));
	} catch (e) {
		console.error('v1 discover follow failed', e);
		return send(request, apiError('add_failed', 'Could not add feed', 400));
	}
};
