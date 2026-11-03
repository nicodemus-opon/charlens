// Shared single-article full-text fetch so the internal endpoint and the
// public v1 API behave identically (cooldown, backfill, error mapping).
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { article, feed } from '$lib/server/db/feeds.schema';
import { scrapeArticle } from '$lib/server/rss/scrape';
import { stripDuplicateImage } from '$lib/server/rss/sanitize';

export const FULLTEXT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export type FulltextResult =
	| { status: 'ok'; cached: boolean; id: number }
	| { status: 'not_found' }
	| { status: 'failed'; message: string };

export async function fetchArticleFulltext(
	userId: string,
	id: number,
	opts: { force?: boolean } = {}
): Promise<FulltextResult> {
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
		.where(and(eq(article.id, id), eq(feed.userId, userId)))
		.limit(1);
	const row = rows[0];
	if (!row) return { status: 'not_found' };
	if (
		!opts.force &&
		row.fullFetchedAt &&
		Date.now() - row.fullFetchedAt.getTime() < FULLTEXT_COOLDOWN_MS
	) {
		return { status: 'ok', cached: true, id: row.id };
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
		return { status: 'ok', cached: false, id };
	} catch (e) {
		console.error(`fulltext scrape failed for article ${id}`, e);
		return { status: 'failed', message: 'Scrape failed for this article' };
	}
}
