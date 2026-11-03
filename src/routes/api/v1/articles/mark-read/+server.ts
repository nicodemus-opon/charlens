import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, ok } from '$lib/server/api/respond';
import { parseFilter, parseLimitParam, invalidFilter } from '$lib/server/api/validate';
import { getSmartRules, markScopeRead } from '$lib/server/rss/refresh';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

/**
 * Bulk triage. Either `{ ids: number[] }` (marks exactly those) or
 * `{ scope: { filter?, feedId?, collectionId?, tagId?, viewId?, q?, limit? } }`
 * (marks the visible window, mirroring the list endpoint).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const g = await guardApi(request, locals, { scope: 'write', bucket: 'articles-mark', limit: 10 });
	if ('response' in g) return g.response;
	let body: { ids?: unknown; scope?: Record<string, unknown> };
	try {
		body = await request.json();
	} catch {
		return send(request, apiError('invalid_body', 'Body must be JSON', 422));
	}
	if (Array.isArray(body.ids)) {
		const ids = [
			...new Set(body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))
		].slice(0, 500);
		if (ids.length === 0) return send(request, apiError('invalid_body', 'ids is empty', 422));
		const { markRead } = await import('$lib/server/rss/refresh');
		await Promise.all(ids.map((id) => markRead(g.user.id, id, true)));
		return send(request, ok({ marked: ids.length }));
	}
	const scope = body.scope ?? {};
	const rawFilter = typeof scope.filter === 'string' ? scope.filter : 'all';
	const filter = parseFilter(rawFilter);
	if (!filter) return send(request, apiError('invalid_filter', invalidFilter(), 422));
	const num = (v: unknown): number | undefined => {
		if (v == null || v === '') return undefined;
		const n = Number(v);
		return Number.isInteger(n) && n > 0 ? n : undefined;
	};
	const viewId = num(scope.viewId ?? scope.view);
	const smart = viewId ? await getSmartRules(g.user.id, viewId) : null;
	try {
		const { marked } = await markScopeRead(g.user.id, {
			feedId: num(scope.feedId ?? scope.feed),
			collectionId: num(scope.collectionId ?? scope.collection),
			tagId: num(scope.tagId ?? scope.tag),
			smart: smart ?? undefined,
			filter: filter as 'today' | 'saved' | 'all' | 'recommended',
			query: typeof scope.q === 'string' ? scope.q : '',
			limit: parseLimitParam(scope.limit == null ? null : String(scope.limit), 100, 500)
		});
		return send(request, ok({ marked }));
	} catch (e) {
		console.error('v1 articles mark-read failed', e);
		return send(request, apiError('mark_failed', 'Could not mark as read', 500));
	}
};
