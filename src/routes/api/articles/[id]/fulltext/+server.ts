import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { article, feed } from '$lib/server/db/feeds.schema';
import { scrapeArticle } from '$lib/server/rss/scrape';
import { stripDuplicateImage } from '$lib/server/rss/sanitize';

const REFETCH_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export const POST: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) return json({ error: 'invalid id' }, { status: 400 });
	const force = url.searchParams.get('force') === '1';

	const rows = await db
		.select({
			id: article.id,
			link: article.link,
			contentHtml: article.contentHtml,
			excerpt: article.excerpt,
			imageUrl: article.imageUrl,
			author: article.author,
			publishedAt: article.publishedAt,
			fullFetchedAt: article.fullFetchedAt
		})
		.from(article)
		.innerJoin(feed, eq(feed.id, article.feedId))
		.where(and(eq(article.id, id), eq(feed.userId, locals.user.id)))
		.limit(1);
	const row = rows[0];
	if (!row) return json({ error: 'not found' }, { status: 404 });

	if (
		!force &&
		row.fullFetchedAt &&
		Date.now() - row.fullFetchedAt.getTime() < REFETCH_COOLDOWN_MS
	) {
		return json({ ok: true, cached: true, id: row.id });
	}

	try {
		const scraped = await scrapeArticle(row.link);
		const imageUrl = row.imageUrl ?? scraped.imageUrl;
		const contentHtml = stripDuplicateImage(scraped.contentHtml || row.contentHtml, imageUrl);
		await db
			.update(article)
			.set({
				contentHtml,
				excerpt: scraped.excerpt || row.excerpt,
				imageUrl,
				author: row.author ?? scraped.author,
				publishedAt: row.publishedAt ?? scraped.publishedAt,
				fullFetchedAt: new Date()
			})
			.where(eq(article.id, id));
		return json({ ok: true, cached: false, id });
	} catch (e) {
		console.error(`fulltext scrape failed for article ${id}`, e);
		return json({ error: 'Scrape failed for this article' }, { status: 502 });
	}
};
