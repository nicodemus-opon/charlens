import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send, withCors } from '$lib/server/api/guard';
import { apiError, ok } from '$lib/server/api/respond';
import { buildOpml, OPML_MAX_BYTES, OpmlError, parseOpml } from '$lib/opml';
import { addFeed, getFeedsWithCounts, populateFeed } from '$lib/server/rss/refresh';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

export const GET: RequestHandler = async ({ request, locals }) => {
	const g = await guardApi(request, locals, { scope: 'read', bucket: 'opml' });
	if ('response' in g) return g.response;
	try {
		const feeds = await getFeedsWithCounts(g.user.id);
		return send(
			request,
			withCors(
				request,
				new Response(
					buildOpml(
						feeds.map((f) => ({ url: f.url, title: f.title, collection: f.collectionName }))
					),
					{
						headers: {
							'Content-Type': 'text/xml; charset=utf-8',
							'Content-Disposition': 'attachment; filename="charlens-feeds.opml"',
							'Cache-Control': 'no-store'
						}
					}
				)
			)
		);
	} catch (e) {
		console.error('v1 opml export failed', e);
		return send(request, apiError('export_failed', 'Could not export OPML', 500));
	}
};

/** Import: multipart `file` field or raw XML body. */
export const POST: RequestHandler = async ({ request, locals }) => {
	const g = await guardApi(request, locals, { scope: 'write', bucket: 'opml', limit: 5 });
	if ('response' in g) return g.response;
	let text: string | null = null;
	const contentType = request.headers.get('content-type') ?? '';
	try {
		if (contentType.includes('multipart/form-data')) {
			const form = await request.formData();
			const file = form.get('file');
			if (!(file instanceof File) || file.size === 0)
				return send(request, apiError('invalid_body', 'file is required', 422));
			if (file.size > OPML_MAX_BYTES)
				return send(request, apiError('invalid_body', 'File too large (max 2 MB)', 422));
			text = await file.text();
		} else {
			text = await request.text();
			if (text.length > OPML_MAX_BYTES)
				return send(request, apiError('invalid_body', 'Body too large (max 2 MB)', 422));
		}
	} catch {
		return send(request, apiError('invalid_body', 'Could not read request body', 422));
	}
	if (!text?.trim()) return send(request, apiError('invalid_body', 'Empty OPML payload', 422));
	let entries;
	try {
		entries = parseOpml(text);
	} catch (e) {
		return send(
			request,
			apiError('invalid_body', e instanceof OpmlError ? e.message : 'Could not parse OPML', 422)
		);
	}
	let added = 0;
	let skipped = 0;
	for (const entry of entries) {
		try {
			new URL(entry.url);
		} catch {
			skipped += 1;
			continue;
		}
		try {
			const feedId = await addFeed(g.user.id, entry.url, entry.collection);
			added += 1;
			setTimeout(() => void populateFeed(feedId, entry.url), 0);
		} catch (e) {
			console.error('v1 opml import feed failed', entry.url, e);
			skipped += 1;
		}
	}
	return send(request, ok({ added, skipped }, 202));
};
