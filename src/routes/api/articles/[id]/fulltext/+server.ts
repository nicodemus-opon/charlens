import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchArticleFulltext } from '$lib/server/api/fulltext-service';

export const POST: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) return json({ error: 'invalid id' }, { status: 400 });
	const force = url.searchParams.get('force') === '1';

	const result = await fetchArticleFulltext(locals.user.id, id, { force });
	if (result.status === 'not_found') return json({ error: 'not found' }, { status: 404 });
	if (result.status === 'failed')
		return json({ error: 'Scrape failed for this article' }, { status: 502 });
	return json({ ok: true, cached: result.cached, id: result.id });
};
