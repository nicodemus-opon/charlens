import { env } from '$env/dynamic/private';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { article } from '$lib/server/db/feeds.schema';
import { looksTruncated, scrapeArticle } from './scrape';
import { stripDuplicateImage } from './sanitize';

export interface FulltextAutoResult {
	checked: number;
	scraped: number;
	failed: number;
	skipped: number;
}

function parsePositiveInt(
	raw: string | undefined,
	fallback: number,
	min: number,
	max: number
): number {
	const n = Number(raw ?? fallback);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Master switch. Env `FULLTEXT_AUTO_ENABLED`, default on. */
export function isFulltextAutoEnabled(): boolean {
	return (env.FULLTEXT_AUTO_ENABLED ?? '1') !== '0';
}

/** Max truncated articles scraped per scheduler run. Env `FULLTEXT_MAX_PER_RUN`, clamped 1–50. */
export function getFulltextMaxPerRun(): number {
	return parsePositiveInt(env.FULLTEXT_MAX_PER_RUN ?? '10', 10, 1, 50);
}

/** Parallel scrapes. Env `FULLTEXT_CONCURRENCY`, clamped 1–5. */
export function getFulltextConcurrency(): number {
	return parsePositiveInt(env.FULLTEXT_CONCURRENCY ?? '3', 3, 1, 5);
}

/**
 * Background backfill: find recent articles that look truncated (excerpt-only),
 * scrape the original link, and persist the full text.
 *
 * - Only rows with `fullFetchedAt IS NULL` are candidates, newest first.
 * - `looksTruncated()` filters out feeds that already ship full bodies.
 * - `fullFetchedAt` is stamped on success AND on failure/empty so a broken
 *   site gets the same 7-day cooldown as the manual endpoint instead of
 *   being retried every 15 min. Manual `?force=1` still bypasses it.
 * - Sequential batches of `concurrency` to avoid hammering origins.
 */
export async function backfillTruncatedArticles(
	opts: {
		maxPerRun?: number;
		concurrency?: number;
		scrapeFn?: typeof scrapeArticle;
		/** Restrict the scan to one feed (used when a freshly added feed's items land). */
		feedId?: number;
	} = {}
): Promise<FulltextAutoResult> {
	const maxPerRun = opts.maxPerRun ?? getFulltextMaxPerRun();
	const concurrency = Math.min(opts.concurrency ?? getFulltextConcurrency(), maxPerRun);
	const scrapeFn = opts.scrapeFn ?? scrapeArticle;
	const result: FulltextAutoResult = { checked: 0, scraped: 0, failed: 0, skipped: 0 };

	// Over-fetch: many recent rows already have full bodies, so scan a wider
	// window and stop once maxPerRun scrapes are attempted.
	const candidates = await db
		.select({
			id: article.id,
			link: article.link,
			contentHtml: article.contentHtml,
			excerpt: article.excerpt,
			imageUrl: article.imageUrl,
			author: article.author,
			publishedAt: article.publishedAt
		})
		.from(article)
		.where(
			opts.feedId === undefined
				? isNull(article.fullFetchedAt)
				: and(isNull(article.fullFetchedAt), eq(article.feedId, opts.feedId))
		)
		.orderBy(desc(article.id))
		.limit(maxPerRun * 10);

	const todo = candidates.filter((c) => looksTruncated(c.contentHtml, c.excerpt));
	result.checked = candidates.length;
	result.skipped = candidates.length - todo.length;
	const batch = todo.slice(0, maxPerRun);

	for (let i = 0; i < batch.length; i += concurrency) {
		const chunk = batch.slice(i, i + concurrency);
		await Promise.all(
			chunk.map(async (row) => {
				try {
					const scraped = await scrapeFn(row.link);
					const imageUrl = row.imageUrl ?? scraped.imageUrl;
					const contentHtml = stripDuplicateImage(scraped.contentHtml || row.contentHtml, imageUrl);
					// Empty scrape = site gave us nothing usable; still stamp the
					// cooldown so we don't retry it every scheduler tick.
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
						.where(eq(article.id, row.id));
					result.scraped += 1;
				} catch (e) {
					console.error(`auto fulltext scrape failed for article ${row.id}`, e);
					try {
						await db
							.update(article)
							.set({ fullFetchedAt: new Date() })
							.where(and(eq(article.id, row.id), isNull(article.fullFetchedAt)));
					} catch {
						// best-effort cooldown stamp; next run will retry
					}
					result.failed += 1;
				}
			})
		);
	}

	return result;
}
