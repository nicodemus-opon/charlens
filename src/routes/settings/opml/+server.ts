import type { RequestHandler } from './$types';
import { buildOpml } from '$lib/opml';
import { requireUser } from '$lib/server/guard';
import { getFeedsWithCounts } from '$lib/server/rss/refresh';

/** Download the user's feeds as an OPML 2.0 file (feeds + collection grouping). */
export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	const feeds = await getFeedsWithCounts(user.id);
	const body = buildOpml(
		feeds.map((f) => ({ url: f.url, title: f.title, collection: f.collectionName }))
	);
	return new Response(body, {
		headers: {
			'Content-Type': 'text/xml; charset=utf-8',
			'Content-Disposition': 'attachment; filename="charlens-feeds.opml"',
			'Cache-Control': 'no-store'
		}
	});
};
