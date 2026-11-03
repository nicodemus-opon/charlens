import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, ok } from '$lib/server/api/respond';
import { addFeed, getFeedsWithCounts, populateFeed } from '$lib/server/rss/refresh';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

function serializeFeed(f: Awaited<ReturnType<typeof getFeedsWithCounts>>[number]) {
	return {
		id: f.id,
		url: f.url,
		title: f.title,
		siteUrl: f.siteUrl,
		imageUrl: f.imageUrl,
		collectionId: f.collectionId,
		collectionName: f.collectionName,
		unread: f.unread,
		total: f.total
	};
}

export const GET: RequestHandler = async ({ request, locals }) => {
	const g = await guardApi(request, locals, { scope: 'read', bucket: 'feeds' });
	if ('response' in g) return g.response;
	try {
		const feeds = await getFeedsWithCounts(g.user.id);
		return send(request, ok({ feeds: feeds.map(serializeFeed) }));
	} catch (e) {
		console.error('v1 feeds list failed', e);
		return send(request, apiError('feeds_failed', 'Could not list feeds', 500));
	}
};

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const g = await guardApi(request, locals, { scope: 'write', bucket: 'feeds-add', limit: 10 });
	if ('response' in g) return g.response;
	let body: { url?: unknown; collection?: unknown };
	try {
		body = await request.json();
	} catch {
		return send(request, apiError('invalid_body', 'Body must be JSON', 422));
	}
	const url = String(body.url ?? '').trim();
	if (!url) return send(request, apiError('invalid_body', 'url is required', 422));
	try {
		new URL(url);
	} catch {
		return send(request, apiError('invalid_body', 'url must be a valid URL', 422));
	}
	const rawCollection = body.collection ?? 'General';
	const collectionRef =
		typeof rawCollection === 'number' && Number.isInteger(rawCollection) && rawCollection > 0
			? rawCollection
			: String(rawCollection).trim() || 'General';
	try {
		const feedId = await addFeed(g.user.id, url, collectionRef);
		const background = () => populateFeed(feedId, url);
		const waiter = (
			platform as { context?: { waitUntil?: (p: Promise<unknown>) => void } } | undefined
		)?.context?.waitUntil;
		if (waiter) waiter(background());
		else setTimeout(() => void background(), 0);
		return send(request, ok({ id: feedId, status: 'provisioning' }, 202));
	} catch (e) {
		console.error('v1 feeds create failed', e);
		return send(request, apiError('add_failed', 'Could not add feed', 400));
	}
};
