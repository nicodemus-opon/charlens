import { env } from '$env/dynamic/private';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	article,
	articleEmbedding,
	feed,
	userArticleState,
	userInterest
} from '$lib/server/db/feeds.schema';
import { articleTag, tag } from '$lib/server/db/tags.schema';
import { normalizeTagName } from '$lib/tags';
import { extractTopics, textFromHtml } from './keywords';
import { rankTags } from './tag-rank';
import { extractKeyphrases, isKeyphraseModelEnabled } from './keyphrases';
import {
	INTEREST_CENTROIDS,
	clusterVectors,
	cosineSimilarity,
	interactionWeight,
	timeDecay
} from '$lib/server/recommend/score';
import { embedText } from './embeddings';

/** Local find-or-create (mirrors refresh.ensureTag without the import cycle). */
async function ensureTagLocal(userId: string, name: string): Promise<number | null> {
	const clean = normalizeTagName(name).toLowerCase();
	if (!clean) return null;
	const existing = await db
		.select({ id: tag.id })
		.from(tag)
		.where(and(eq(tag.userId, userId), eq(tag.name, clean)))
		.limit(1);
	if (existing[0]) return existing[0].id;
	const inserted = await db
		.insert(tag)
		.values({ userId, name: clean })
		.onConflictDoNothing({ target: [tag.userId, tag.name] })
		.returning({ id: tag.id });
	if (inserted[0]) return inserted[0].id;
	const retry = await db
		.select({ id: tag.id })
		.from(tag)
		.where(and(eq(tag.userId, userId), eq(tag.name, clean)))
		.limit(1);
	return retry[0]?.id ?? null;
}

export interface EnrichAutoResult {
	checked: number;
	enriched: number;
	failed: number;
	skipped: number;
}

function parsePositiveInt(raw: string | undefined, fallback: number, min: number, max: number) {
	const n = Number(raw ?? fallback);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(n)));
}

export function isEnrichAutoEnabled(): boolean {
	return (env.ENRICH_AUTO_ENABLED ?? '1') !== '0';
}

export function getEnrichMaxPerRun(): number {
	return parsePositiveInt(env.ENRICH_MAX_PER_RUN ?? '25', 25, 1, 100);
}

export function getEnrichConcurrency(): number {
	return parsePositiveInt(env.ENRICH_CONCURRENCY ?? '3', 3, 1, 5);
}

function parseVector(value: unknown): number[] | null {
	if (!Array.isArray(value)) return null;
	if (value.length === 0) return null;
	if (!value.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
	return value as number[];
}

/**
 * Parse a stored embedding as a list of centroids. Accepts both the v2
 * multi-centroid layout (number[][]) and legacy single vectors (number[]).
 */
function parseVectors(value: unknown): number[][] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	if (value.every((v) => typeof v === 'number')) {
		return parseVector(value) ? [value as number[]] : null;
	}
	const out: number[][] = [];
	for (const row of value) {
		const v = parseVector(row);
		if (v) out.push(v);
	}
	return out.length > 0 ? out : null;
}

function parseStrings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** Cross-module access to the stored-embedding parsers (used by refresh ranking). */
export {
	parseVector as parseStoredVector,
	parseVectors as parseStoredVectors,
	parseStrings as parseStoredStrings
};

/**
 * Enrich one article: extract tags/topics/entities, attach up to 5 tags
 * (idempotent, never removes user tags), persist topics/entities, and embed
 * the text into the article_embedding row. The embed step degrades to null
 * when the model is unavailable — tags still write.
 */
export async function enrichArticle(articleId: number): Promise<boolean> {
	const rows = await db
		.select({
			id: article.id,
			feedId: article.feedId,
			title: article.title,
			excerpt: article.excerpt,
			contentHtml: article.contentHtml
		})
		.from(article)
		.where(eq(article.id, articleId))
		.limit(1);
	const row = rows[0];
	if (!row) return false;

	const owner = await db
		.select({ userId: feed.userId })
		.from(feed)
		.where(eq(feed.id, row.feedId))
		.limit(1);
	const userId = owner[0]?.userId;
	if (!userId) return false;

	const text = textFromHtml(row.contentHtml).slice(0, 5000) || (row.excerpt ?? '');
	// keywords.ts is the candidate generator (over-produce at limit 12);
	// tag-rank.ts does the semantic rerank/filter down to the final 5.
	const extracted = extractTopics({ title: row.title, text }, 12);
	let candidates = extracted.tags;
	if (isKeyphraseModelEnabled()) {
		// Phase 2: open-vocab keyphrases join the candidate pool. Substring /
		// overlap dups of heuristic candidates are skipped so the reranker
		// never sees "ai" and "ai chips" as separate entries twice.
		const kp = await extractKeyphrases(`${row.title}. ${text.slice(0, 2000)}`);
		const covered = (w: string) =>
			candidates.some((t) => t === w || t.includes(w) || w.includes(t));
		candidates = [...candidates, ...kp.filter((k) => !covered(k))];
	}
	const tags = await rankTags(candidates, { title: row.title, text }, 5);
	const topics = tags.slice();
	const entities = extracted.entities;

	for (const name of tags.slice(0, 5)) {
		const tagId = await ensureTagLocal(userId, name);
		if (!tagId) continue;
		await db
			.insert(articleTag)
			.values({ tagId, articleId: row.id, source: 'enrich' })
			.onConflictDoNothing({ target: [articleTag.tagId, articleTag.articleId] });
	}

	const vector = await embedText(`${row.title}\n${row.excerpt ?? ''}\n${text.slice(0, 1500)}`);
	const values: typeof articleEmbedding.$inferInsert = {
		articleId: row.id,
		topics,
		entities,
		embeddedAt: new Date(),
		...(vector ? { embedding: vector } : {})
	};
	await db
		.insert(articleEmbedding)
		.values(values)
		.onConflictDoUpdate({
			target: articleEmbedding.articleId,
			set: vector
				? { topics, entities, embedding: vector, embeddedAt: new Date() }
				: { topics, entities, embeddedAt: new Date() }
		});
	return true;
}

/**
 * Backfill vectors for rows the keyword pass already stamped while the model
 * was unavailable (embedding IS NULL). Newest first, capped per run.
 */
export async function backfillMissingVectors(
	opts: { maxPerRun?: number } = {}
): Promise<EnrichAutoResult> {
	const maxPerRun = opts.maxPerRun ?? getEnrichMaxPerRun();
	const result: EnrichAutoResult = { checked: 0, enriched: 0, failed: 0, skipped: 0 };
	const candidates = await db
		.select({ id: articleEmbedding.articleId })
		.from(articleEmbedding)
		.where(isNull(articleEmbedding.embedding))
		.orderBy(desc(articleEmbedding.embeddedAt))
		.limit(maxPerRun);
	result.checked = candidates.length;
	for (const row of candidates) {
		try {
			const ok = await enrichArticle(row.id);
			if (ok) result.enriched += 1;
			else result.skipped += 1;
		} catch (e) {
			console.error(`vector backfill failed for article ${row.id}`, e);
			result.failed += 1;
		}
	}
	return result;
}

/**
 * Recompute one user's interest model: engagement-weighted, time-decayed
 * average over embedded articles they interacted with — clustered into up to
 * INTEREST_CENTROIDS centroids so multi-interest users (tech + cooking +
 * politics) match each interest instead of a mushy middle. Bounces are
 * excluded. Also refreshes topic/source preference histograms.
 *
 * The embedding column holds an array of centroids (number[][]); legacy
 * single-vector rows (number[]) are still read back correctly.
 */
export async function updateUserInterest(userId: string): Promise<boolean> {
	const now = Date.now();
	const engaged = await db
		.select({
			embedding: articleEmbedding.embedding,
			topics: articleEmbedding.topics,
			feedId: article.feedId,
			openCount: userArticleState.openCount,
			isRead: userArticleState.isRead,
			isSaved: userArticleState.isSaved,
			finished: userArticleState.finished,
			totalDwellMs: userArticleState.totalDwellMs,
			maxScrollPct: userArticleState.maxScrollPct,
			updatedAt: userArticleState.updatedAt
		})
		.from(userArticleState)
		.innerJoin(article, eq(article.id, userArticleState.articleId))
		.innerJoin(feed, and(eq(feed.id, article.feedId), eq(feed.userId, userId)))
		.innerJoin(articleEmbedding, eq(articleEmbedding.articleId, article.id))
		.where(eq(userArticleState.userId, userId))
		.orderBy(desc(userArticleState.updatedAt))
		.limit(200);

	const vectors: number[][] = [];
	const weights: number[] = [];
	const topicScores = new Map<string, number>();
	const sourceScores = new Map<number, number>();
	for (const row of engaged) {
		const vec = parseVector(row.embedding);
		if (!vec) continue;
		const weight =
			interactionWeight({
				openCount: row.openCount,
				isRead: row.isRead,
				isSaved: row.isSaved,
				finished: row.finished,
				totalDwellMs: row.totalDwellMs,
				maxScrollPct: row.maxScrollPct
			}) * timeDecay(now - (row.updatedAt?.getTime() ?? now));
		if (!(weight > 0.3)) continue;
		vectors.push(vec);
		weights.push(weight);
		for (const t of parseStrings(row.topics)) {
			const key = t.toLowerCase().slice(0, 60);
			if (key) topicScores.set(key, (topicScores.get(key) ?? 0) + weight);
		}
		sourceScores.set(row.feedId, (sourceScores.get(row.feedId) ?? 0) + weight);
	}
	if (vectors.length === 0) return false;
	const centroids = clusterVectors(vectors, weights, INTEREST_CENTROIDS);
	if (centroids.length === 0) return false;

	const topEntries = (m: Map<string | number, number>, limit: number) =>
		[...m.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit)
			.map(([key, weight]) => ({ key: String(key), weight: Math.round(weight * 100) / 100 }));
	const stamp = new Date();
	await db
		.insert(userInterest)
		.values({
			userId,
			embedding: centroids,
			topicPrefs: topEntries(topicScores as Map<string | number, number>, 20),
			sourcePrefs: topEntries(sourceScores, 20),
			updatedAt: stamp
		})
		.onConflictDoUpdate({
			target: userInterest.userId,
			set: {
				embedding: centroids,
				topicPrefs: topEntries(topicScores as Map<string | number, number>, 20),
				sourcePrefs: topEntries(sourceScores, 20),
				updatedAt: stamp
			}
		});
	return true;
}

/** Best-centroid cosine similarity between a stored embedding and the interest model. */
export function similarityToInterest(embedding: unknown, interest: unknown): number | null {
	const a = parseVectors(embedding);
	const b = parseVectors(interest);
	if (!a || !b) return null;
	let best: number | null = null;
	for (const va of a) {
		for (const vb of b) {
			const s = cosineSimilarity(va, vb);
			if (best == null || s > best) best = s;
		}
	}
	return best;
}

/**
 * Scheduled backfill: newest articles without an enrichment row get tagged.
 * Stamps the embedding row even when extraction yields nothing so empty
 * articles aren't retried every tick (same philosophy as the fulltext
 * 7-day cooldown).
 */
export async function backfillUnenrichedArticles(
	opts: {
		maxPerRun?: number;
		concurrency?: number;
		/** Restrict the scan to one feed (used when a freshly added feed's items land). */
		feedId?: number;
	} = {}
): Promise<EnrichAutoResult> {
	const maxPerRun = opts.maxPerRun ?? getEnrichMaxPerRun();
	const concurrency = Math.min(opts.concurrency ?? getEnrichConcurrency(), maxPerRun);
	const result: EnrichAutoResult = { checked: 0, enriched: 0, failed: 0, skipped: 0 };

	const candidates = await db
		.select({ id: article.id })
		.from(article)
		.leftJoin(articleEmbedding, eq(articleEmbedding.articleId, article.id))
		.where(
			opts.feedId === undefined
				? isNull(articleEmbedding.articleId)
				: and(isNull(articleEmbedding.articleId), eq(article.feedId, opts.feedId))
		)
		.orderBy(desc(article.id))
		.limit(maxPerRun * 4);
	result.checked = candidates.length;

	for (let i = 0; i < candidates.length; i += concurrency) {
		const chunk = candidates.slice(i, i + concurrency);
		await Promise.all(
			chunk.map(async (row) => {
				try {
					const ok = await enrichArticle(row.id);
					if (ok) result.enriched += 1;
					else result.skipped += 1;
				} catch (e) {
					console.error(`auto enrich failed for article ${row.id}`, e);
					try {
						await db
							.insert(articleEmbedding)
							.values({ articleId: row.id, topics: [], entities: [] })
							.onConflictDoNothing({ target: articleEmbedding.articleId });
					} catch {
						// best-effort stamp; next run will retry
					}
					result.failed += 1;
				}
			})
		);
		if (result.enriched >= maxPerRun) break;
	}

	return result;
}

/**
 * Refresh interest vectors for users with recent engagement (called from the
 * scheduler once per tick). Capped so a big multi-user instance stays cheap.
 */
export async function refreshAllUserInterests(limit = 100): Promise<{
	updated: number;
	skipped: number;
}> {
	const active = await db
		.selectDistinct({ userId: userArticleState.userId })
		.from(userArticleState)
		.limit(limit);
	let updated = 0;
	let skipped = 0;
	for (const row of active) {
		try {
			if (await updateUserInterest(row.userId)) updated += 1;
			else skipped += 1;
		} catch (e) {
			console.error(`interest refresh failed for user ${row.userId}`, e);
			skipped += 1;
		}
	}
	return { updated, skipped };
}

/** Test helper: count un-enriched articles. */
export async function countUnenrichedArticles(): Promise<number> {
	const rows = await db
		.select({ n: sql<number>`count(*)`.mapWith(Number) })
		.from(article)
		.leftJoin(articleEmbedding, eq(articleEmbedding.articleId, article.id))
		.where(isNull(articleEmbedding.articleId));
	return rows[0]?.n ?? 0;
}
