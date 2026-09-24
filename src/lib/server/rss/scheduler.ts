import { env } from '$env/dynamic/private';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { article, feed } from '$lib/server/db/feeds.schema';
import { eq } from 'drizzle-orm';
import {
	backfillNewFeedItems,
	fetchFeedForRefresh,
	isFeedStale,
	upsertItems
} from '$lib/server/rss/refresh';
import { fetchFeed } from '$lib/server/rss/parser';
import { backfillTruncatedArticles, isFulltextAutoEnabled } from '$lib/server/rss/fulltext';
import {
	backfillMissingVectors,
	backfillUnenrichedArticles,
	isEnrichAutoEnabled,
	refreshAllUserInterests
} from '$lib/server/enrich/enrich';

export interface SchedulerRunResult {
	checked: number;
	refreshed: number;
	added: number;
	errors: number;
	fulltextScraped: number;
	fulltextFailed: number;
	enrichEnriched: number;
	enrichFailed: number;
	embedEmbedded: number;
	embedFailed: number;
	interestUpdated: number;
}

export interface SchedulerStatus extends SchedulerRunResult {
	running: boolean;
	intervalMs: number;
	lastRunAt: string | null;
	lastError: string | null;
}

const BOOT_DELAY_MS = 10_000;

function parseIntervalMin(raw: string | undefined): number {
	const n = Number(raw ?? 15);
	if (!Number.isFinite(n)) return 15;
	return Math.min(1440, Math.max(1, Math.floor(n)));
}

/** Refresh cadence in ms. Env `FEED_REFRESH_INTERVAL_MIN`, clamped 1–1440. */
export function getRefreshIntervalMs(): number {
	return parseIntervalMin(env.FEED_REFRESH_INTERVAL_MIN) * 60 * 1000;
}

export function isSchedulerEnabled(): boolean {
	return (env.FEED_REFRESH_SCHEDULER_ENABLED ?? '1') !== '0';
}

async function refreshSingleFeed(
	f: typeof feed.$inferSelect,
	fetchFn: typeof fetchFeed = fetchFeed
): Promise<{ added: number; failed: boolean }> {
	try {
		// Placeholder rows (add-time populate failed) re-discover their real
		// feed URL here instead of refetching a non-feed page every tick.
		const { parsed, healed } = await fetchFeedForRefresh(f, fetchFn);
		const before = await db
			.select({ n: sql<number>`count(*)`.mapWith(Number) })
			.from(article)
			.where(eq(article.feedId, f.id));
		await upsertItems(f.id, parsed.items);
		const after = await db
			.select({ n: sql<number>`count(*)`.mapWith(Number) })
			.from(article)
			.where(eq(article.feedId, f.id));
		await db.update(feed).set({ lastFetchedAt: new Date() }).where(eq(feed.id, f.id));
		if (healed) await backfillNewFeedItems(f.id);
		return { added: (after[0]?.n ?? 0) - (before[0]?.n ?? 0), failed: false };
	} catch (e) {
		console.error(`scheduled refresh failed for ${f.url}`, e);
		return { added: 0, failed: true };
	}
}

/**
 * Refresh every stale feed across all users (feeds are per-user rows, but the
 * schedule runs once per server process). Sequential to avoid hammering
 * sources; each feed is isolated in try/catch so one failure never aborts
 * the run.
 */
export async function refreshAllStaleFeeds(
	opts: { force?: boolean; fetchFn?: typeof fetchFeed } = {}
): Promise<SchedulerRunResult> {
	const { force = false, fetchFn = fetchFeed } = opts;
	const feeds = await db.select().from(feed);
	const result: SchedulerRunResult = {
		checked: feeds.length,
		refreshed: 0,
		added: 0,
		errors: 0,
		fulltextScraped: 0,
		fulltextFailed: 0,
		enrichEnriched: 0,
		enrichFailed: 0,
		embedEmbedded: 0,
		embedFailed: 0,
		interestUpdated: 0
	};
	for (const f of feeds) {
		if (!isFeedStale(f.lastFetchedAt, force)) continue;
		result.refreshed += 1;
		const { added, failed } = await refreshSingleFeed(f, fetchFn);
		result.added += added;
		if (failed) result.errors += 1;
	}
	// Automated full-text backfill: after new items land, scrape the ones
	// that look truncated. Failures are isolated — feed counts still report.
	if (isFulltextAutoEnabled()) {
		try {
			const ft = await backfillTruncatedArticles();
			result.fulltextScraped = ft.scraped;
			result.fulltextFailed = ft.failed;
		} catch (e) {
			console.error('scheduled fulltext backfill failed', e);
		}
	}
	// Auto-tagging/topics backfill: newest un-enriched articles get keyword
	// tags + topics/entities. Isolated so enrichment never breaks refresh.
	if (isEnrichAutoEnabled()) {
		try {
			const en = await backfillUnenrichedArticles();
			result.enrichEnriched = en.enriched;
			result.enrichFailed = en.failed;
		} catch (e) {
			console.error('scheduled enrich backfill failed', e);
		}
		// Vector catch-up for rows stamped while the model was unavailable,
		// then per-user interest vectors so semantic ranking has data.
		try {
			const vec = await backfillMissingVectors();
			result.embedEmbedded = vec.enriched;
			result.embedFailed = vec.failed;
		} catch (e) {
			console.error('scheduled vector backfill failed', e);
		}
		try {
			const ints = await refreshAllUserInterests();
			result.interestUpdated = ints.updated;
		} catch (e) {
			console.error('scheduled interest refresh failed', e);
		}
	}
	return result;
}

const globalState = globalThis as unknown as {
	__charlensScheduler?: {
		timer: ReturnType<typeof setInterval>;
		lastRunAt: string | null;
		lastResult: SchedulerRunResult;
		lastError: string | null;
	};
};

/** Start the interval once per server process. Safe to call on every import. */
export function startScheduler(): void {
	if (globalState.__charlensScheduler) return;
	if (!isSchedulerEnabled()) {
		console.log('feed scheduler disabled (FEED_REFRESH_SCHEDULER_ENABLED=0)');
		return;
	}
	const intervalMs = getRefreshIntervalMs();
	const state = {
		timer: undefined as unknown as ReturnType<typeof setInterval>,
		lastRunAt: null as string | null,
		lastResult: {
			checked: 0,
			refreshed: 0,
			added: 0,
			errors: 0,
			fulltextScraped: 0,
			fulltextFailed: 0,
			enrichEnriched: 0,
			enrichFailed: 0,
			embedEmbedded: 0,
			embedFailed: 0,
			interestUpdated: 0
		} as SchedulerRunResult,
		lastError: null as string | null
	};

	const run = async () => {
		try {
			state.lastResult = await refreshAllStaleFeeds();
			state.lastRunAt = new Date().toISOString();
			state.lastError = null;
			console.log(
				`scheduled feed refresh: ${state.lastResult.refreshed}/${state.lastResult.checked} feeds, +${state.lastResult.added} articles, fulltext +${state.lastResult.fulltextScraped}, enrich +${state.lastResult.enrichEnriched}, embed +${state.lastResult.embedEmbedded}, interest +${state.lastResult.interestUpdated}`
			);
		} catch (e) {
			state.lastError = e instanceof Error ? e.message : String(e);
			console.error('scheduled feed refresh run failed', e);
		}
	};

	// First run shortly after boot (catches up stale feeds), then on cadence.
	const bootTimer = setTimeout(() => run().catch(() => undefined), BOOT_DELAY_MS);
	if (typeof bootTimer.unref === 'function') bootTimer.unref();
	state.timer = setInterval(() => run().catch(() => undefined), intervalMs);
	if (typeof state.timer.unref === 'function') state.timer.unref();
	globalState.__charlensScheduler = state;
	console.log(`feed scheduler started (every ${intervalMs / 60000} min)`);
}

export function getSchedulerStatus(): SchedulerStatus {
	const s = globalState.__charlensScheduler;
	return {
		running: !!s,
		intervalMs: getRefreshIntervalMs(),
		lastRunAt: s?.lastRunAt ?? null,
		lastError: s?.lastError ?? null,
		checked: s?.lastResult.checked ?? 0,
		refreshed: s?.lastResult.refreshed ?? 0,
		added: s?.lastResult.added ?? 0,
		errors: s?.lastResult.errors ?? 0,
		fulltextScraped: s?.lastResult.fulltextScraped ?? 0,
		fulltextFailed: s?.lastResult.fulltextFailed ?? 0,
		enrichEnriched: s?.lastResult.enrichEnriched ?? 0,
		enrichFailed: s?.lastResult.enrichFailed ?? 0,
		embedEmbedded: s?.lastResult.embedEmbedded ?? 0,
		embedFailed: s?.lastResult.embedFailed ?? 0,
		interestUpdated: s?.lastResult.interestUpdated ?? 0
	};
}

/** Test-only: clear the process-wide scheduler singleton. */
export function _resetSchedulerForTests(): void {
	const s = globalState.__charlensScheduler;
	if (s) clearInterval(s.timer);
	delete globalState.__charlensScheduler;
}
