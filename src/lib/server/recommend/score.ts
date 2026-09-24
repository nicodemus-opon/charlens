// Recommendation scoring (pure helpers — no DB imports, unit-testable).
//
// v2 model:
// - Engagement-weighted, time-decayed affinities with BM25-style saturation
//   (diminishing returns) instead of max-normalization, plus tag IDF so
//   generic tags don't dominate.
// - Weighted blend whose weights sum to 1, with a small additive
//   deterministic exploration term. Separate search/recommend profiles so
//   query intent isn't diluted by feed affinity.
// - MMR diversity rerank with near-duplicate collapse (embeddings) and
//   per-feed / per-topic caps.

export interface AffinityMaps {
	feedScores: Map<number, number>;
	tagScores: Map<string, number>;
	authorScores: Map<string, number>;
	/** False for cold-start users (no weighted engagement) — caller falls back to Today ordering. */
	hasSignals: boolean;
}

export interface RecommendCandidate {
	id: number;
	feedId: number;
	author: string | null;
	publishedAt: Date | null;
	isRead: boolean;
	isSaved: boolean;
	tags: string[];
	/** Cosine similarity to the user's interest model (best-centroid match). Null until embeddings exist. */
	semanticSimilarity?: number | null;
	/** Extra topic/entity strings (from article embeddings) for affinity matching. */
	topics?: string[];
	/** Engagement detail for graded read handling (vs the old 1 vs 0.15 cliff). */
	finished?: boolean;
	dwellMs?: number | null;
	scrollPct?: number | null;
	/** Quality priors. */
	hasImage?: boolean;
	excerptLength?: number;
	titleLength?: number;
}

export interface ScoreOptions {
	now?: number;
	/** Deterministic exploration flag (0/1 normally; >1 when a shuffle seed
	 *  amplifies the slot via SHUFFLE_EXPLORATION_MULTIPLIER). */
	explorationBoost?: number;
	mode?: 'recommend' | 'search';
	/** Precomputed 0..1 IDF per lowercased tag over the candidate window. */
	tagIdf?: Map<string, number>;
	/** Precomputed 0..SEARCH_KEYWORD_BOOST lexical match (search mode). */
	keywordBoost?: number;
}

export interface ScoredCandidate {
	id: number;
	score: number;
	reasons: string[];
	components: Record<string, number>;
}

/** Recommend blend — sums to 1. Exploration is additive on top (see EXPLORATION_WEIGHT).
 *  The read component is deliberately large so just-opened stories sink
 *  visibly below unseen peers instead of lingering on top. */
export const RECOMMEND_WEIGHTS = {
	semantic: 0.28,
	tag: 0.2,
	feed: 0.11,
	freshness: 0.13,
	author: 0.05,
	quality: 0.05,
	read: 0.18
} as const;

/** Search blend — query intent dominates; feed/tag/author affinity ignored. */
export const SEARCH_WEIGHTS = {
	semantic: 0.6,
	keyword: 0.25,
	freshness: 0.1,
	quality: 0.05
} as const;

/** Saturation point K in w/(w+K): larger raw aggregates need larger K. */
export const AFFINITY_SATURATION = { feed: 8, tag: 5, author: 3 } as const;

/** Engagement memory: weights halve every 30 days. */
export const ENGAGEMENT_HALF_LIFE_MS = 30 * 86_400_000;

/** Additive bonus for the deterministic exploration slot. */
export const EXPLORATION_WEIGHT = 0.03;

/**
 * Multiplier applied to the exploration slot when an explicit shuffle seed
 * is present (sidebar re-click / Shuffle button). The base +0.03 is too
 * small to visibly move a settled ranking — ×5 (+0.15 for the elected 8%)
 * reshuffles similarly-scored stories while relevance still dominates.
 */
export const SHUFFLE_EXPLORATION_MULTIPLIER = 5;

/** Cosine similarity at/above which two candidates collapse to one. */
export const DEDUP_SIM_THRESHOLD = 0.92;

/** MMR tradeoff: 1 = pure relevance, 0 = pure diversity. */
export const MMR_LAMBDA = 0.8;

/** Number of interest centroids per user (multi-interest model). */
export const INTEREST_CENTROIDS = 3;

/** Two-regime freshness: gentle linear decay over the first 72h (1 → 0.65),
 *  then exponential decay with a 0.08 floor so week-old gems stay retrievable. */
export function freshnessScore(publishedAt: Date | null, now = Date.now()): number {
	if (!publishedAt) return 0.4;
	const ageHours = Math.max(0, (now - publishedAt.getTime()) / 3_600_000);
	if (ageHours <= 72) return 1 - 0.35 * (ageHours / 72);
	return Math.max(0.08, 0.65 * Math.exp(-(ageHours - 72) / 96));
}

/** Cosine similarity. Returns 0 on mismatch/degenerate input. */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Exponential time decay: 1 at age 0, 0.5 after one half-life. */
export function timeDecay(ageMs: number, halfLifeMs = ENGAGEMENT_HALF_LIFE_MS): number {
	if (!(ageMs > 0)) return 1;
	return Math.exp((-Math.LN2 * ageMs) / halfLifeMs);
}

export interface EngagementState {
	openCount?: number | null;
	isRead?: boolean | null;
	isSaved?: boolean | null;
	finished?: boolean | null;
	totalDwellMs?: number | null;
	maxScrollPct?: number | null;
}

/**
 * True when there is positive evidence the user bounced: opened but barely
 * looked (tiny dwell, no scroll-through, never finished/saved). Missing
 * telemetry alone (zeros across the board) is NOT a bounce — old rows and
 * open-only events carry no dwell/scroll data.
 */
export function looksBounced(s: {
	finished?: boolean | null;
	isSaved?: boolean | null;
	openCount?: number | null;
	dwellMs?: number | null;
	scrollPct?: number | null;
}): boolean {
	if (s.finished || s.isSaved) return false;
	if (!((s.openCount ?? 0) > 0)) return false;
	const dwell = s.dwellMs ?? 0;
	const scroll = s.scrollPct ?? 0;
	if (dwell <= 0 && scroll <= 0) return false;
	return dwell < 10_000 && scroll < 25;
}
/**
 * Weight of one article interaction. Dwell/scroll/finish/save scale the
 * reward; a bounce (opened but barely looked at, never finished/saved) is
 * negative so lookalikes get demoted instead of promoted.
 */
export function interactionWeight(s: EngagementState): number {
	const opens = Math.min(Math.max(s.openCount ?? 0, 0), 5);
	const dwellMin = Math.min(Math.max(s.totalDwellMs ?? 0, 0) / 60_000, 2);
	const scroll = Math.max(s.maxScrollPct ?? 0, 0);
	const saved = !!s.isSaved;
	const finished = !!s.finished;
	const read = !!s.isRead;

	if (
		looksBounced({
			finished,
			isSaved: saved,
			openCount: s.openCount,
			dwellMs: s.totalDwellMs,
			scrollPct: s.maxScrollPct
		})
	) {
		return -1.5;
	}
	let w = opens * 0.6;
	if (read) w += 1;
	w += dwellMin * 0.8;
	if (scroll >= 75) w += 0.8;
	else if (scroll >= 40) w += 0.3;
	if (finished) w += 2;
	if (saved) w += 3;
	return w;
}

/** BM25-style saturation: diminishing returns, bounded 0..1, corpus-stable
 *  (unlike max-normalization, a new popular feed doesn't rescale everyone). */
export function saturate(weight: number, k: number): number {
	if (!(weight > 0)) return 0;
	return weight / (weight + k);
}

/** IDF weight normalized to 0..1 over a candidate window of totalDocs. */
export function idfWeight(docFreq: number, totalDocs: number): number {
	if (totalDocs <= 0) return 1;
	const df = Math.max(0, docFreq);
	return Math.log(1 + totalDocs / (1 + df)) / Math.log(1 + totalDocs);
}

function saturateScores(
	counts: Map<string | number, number>,
	k: number
): Map<string | number, number> {
	const out = new Map<string | number, number>();
	for (const [key, w] of counts) {
		const s = saturate(w, k);
		if (s > 0) out.set(key, s);
	}
	return out;
}

/** Build 0–1 affinity maps from (decayed, engagement-weighted) aggregates. Pure for tests. */
export function buildAffinityMaps(raw: {
	feedCounts: Map<number, number>;
	tagCounts: Map<string, number>;
	authorCounts: Map<string, number>;
}): AffinityMaps {
	const feedScores = saturateScores(raw.feedCounts, AFFINITY_SATURATION.feed) as Map<
		number,
		number
	>;
	const tagScores = saturateScores(raw.tagCounts, AFFINITY_SATURATION.tag) as Map<string, number>;
	const authorScores = saturateScores(raw.authorCounts, AFFINITY_SATURATION.author) as Map<
		string,
		number
	>;
	const hasSignals = feedScores.size > 0 || tagScores.size > 0;
	return { feedScores, tagScores, authorScores, hasSignals };
}

/**
 * Tag affinity: mean of the top-2 matching tags (IDF-weighted), so one noisy
 * extractor tag can't single-handedly carry an article, and generic tags
 * contribute less than distinctive ones.
 */
export function tagAffinity(
	tags: string[],
	scores: Map<string, number>,
	idfOf?: (tag: string) => number
): number {
	if (tags.length === 0) return 0;
	const vals = tags.map((t) => {
		const key = t.toLowerCase();
		return (scores.get(key) ?? 0) * (idfOf ? idfOf(key) : 1);
	});
	vals.sort((a, b) => b - a);
	const top = vals.slice(0, 2);
	return (top[0] + (top[1] ?? top[0])) / 2;
}

/** Graded read handling: unread=1, finished-but-read=0.4, skimmed=0.15, bounced=0.05.
 *  Combined with the read blend weight this strongly demotes anything already
 *  opened while keeping it retrievable at the bottom of the list. */
export function readGrade(c: {
	isRead: boolean;
	isSaved: boolean;
	finished?: boolean;
	dwellMs?: number | null;
	scrollPct?: number | null;
}): number {
	if (!c.isRead) return 1;
	if (c.isSaved || c.finished) return 0.4;
	if (looksBounced({ openCount: 1, dwellMs: c.dwellMs, scrollPct: c.scrollPct })) return 0.05;
	return 0.15;
}

/** Small quality prior from cheap metadata (no content fetch needed). */
export function qualityScore(c: {
	hasImage?: boolean;
	excerptLength?: number;
	titleLength?: number;
}): number {
	let q = 0.5;
	if (c.hasImage) q += 0.2;
	const excerpt = c.excerptLength ?? 0;
	if (excerpt >= 200) q += 0.15;
	else if (excerpt < 40) q -= 0.1;
	const title = c.titleLength ?? 0;
	if (title >= 20 && title <= 120) q += 0.1;
	return Math.max(0, Math.min(1, q));
}

/**
 * Additive boost so exact keyword hits stay competitive with semantic
 * matches when a search query is ranked by embeddings (see
 * refresh.getRecommendedArticles).
 */
export const SEARCH_KEYWORD_BOOST = 0.25;

/** Lexical-match helper for semantic search ranking (unit-testable).
 *  Exact-phrase hit earns the full boost; multi-token partial matches earn
 *  proportionally less. */
export function keywordMatchBoost(
	query: string | null | undefined,
	fields: { title?: string | null; excerpt?: string | null; author?: string | null }
): number {
	const q = query?.trim().toLowerCase();
	if (!q) return 0;
	const haystack = [fields.title, fields.excerpt, fields.author]
		.filter((v): v is string => typeof v === 'string' && v.length > 0)
		.join('\n')
		.toLowerCase();
	if (haystack.includes(q)) return SEARCH_KEYWORD_BOOST;
	const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
	if (tokens.length <= 1) return 0;
	const matched = tokens.filter((t) => haystack.includes(t)).length;
	if (matched === 0) return 0;
	return SEARCH_KEYWORD_BOOST * (matched / tokens.length) * 0.8;
}

/** FNV-1a 32-bit hash (deterministic exploration without Math.random). */
export function hashForExplore(key: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/**
 * Deterministic exploration slot: ~8% of (user, article, day) combos get a 1,
 * stable within a calendar day so pagination doesn't reshuffle on reload.
 * Pass a per-click `seed` (e.g. a `shuffle` URL param) to reshuffle: a new
 * seed elects a different 8% while staying stable for that seed value.
 */
export function deterministicExploreBoost(
	userId: string,
	articleId: number,
	now = Date.now(),
	seed: string | number = ''
): number {
	const dayBucket = Math.floor(now / 86_400_000);
	const key =
		seed === '' || seed == null
			? `${userId}:${articleId}:${dayBucket}`
			: `${userId}:${articleId}:${dayBucket}:${seed}`;
	return hashForExplore(key) % 100 < 8 ? 1 : 0;
}

export function scoreCandidate(
	c: RecommendCandidate,
	aff: AffinityMaps,
	opts: ScoreOptions = {}
): ScoredCandidate {
	const now = opts.now ?? Date.now();
	const explorationBoost = opts.explorationBoost ?? 0;
	const mode = opts.mode ?? 'recommend';
	const reasons: string[] = [];
	const components: Record<string, number> = {};

	const feedAff = aff.feedScores.get(c.feedId) ?? 0;
	const idfOf = opts.tagIdf ? (t: string) => opts.tagIdf!.get(t) ?? 1 : undefined;
	const allTags = [...c.tags, ...(c.topics ?? [])];
	const tagAff = tagAffinity(allTags, aff.tagScores, idfOf);
	const authorAff =
		c.author?.trim() !== '' && c.author
			? (aff.authorScores.get(c.author.trim().toLowerCase()) ?? 0)
			: 0;
	const fresh = freshnessScore(c.publishedAt, now);
	const read = readGrade(c);
	const quality = qualityScore(c);
	const semantic =
		c.semanticSimilarity == null ? 0 : Math.max(0, Math.min(1, c.semanticSimilarity));

	let score: number;
	if (mode === 'search') {
		const keyword01 = Math.max(0, Math.min(1, (opts.keywordBoost ?? 0) / SEARCH_KEYWORD_BOOST));
		components.semantic = SEARCH_WEIGHTS.semantic * semantic;
		components.keyword = SEARCH_WEIGHTS.keyword * keyword01;
		components.freshness = SEARCH_WEIGHTS.freshness * fresh;
		components.quality = SEARCH_WEIGHTS.quality * quality;
		score = components.semantic + components.keyword + components.freshness + components.quality;
		if (semantic > 0.5) reasons.push('Semantically similar to your search');
		if (keyword01 >= 1) reasons.push('Exact keyword match');
		else if (keyword01 > 0) reasons.push('Partial keyword match');
		if (fresh > 0.85) reasons.push('Fresh story');
	} else {
		components.semantic = RECOMMEND_WEIGHTS.semantic * semantic;
		components.tag = RECOMMEND_WEIGHTS.tag * tagAff;
		components.feed = RECOMMEND_WEIGHTS.feed * feedAff;
		components.freshness = RECOMMEND_WEIGHTS.freshness * fresh;
		components.author = RECOMMEND_WEIGHTS.author * authorAff;
		components.quality = RECOMMEND_WEIGHTS.quality * quality;
		components.read = RECOMMEND_WEIGHTS.read * read;
		score =
			components.semantic +
			components.tag +
			components.feed +
			components.freshness +
			components.author +
			components.quality +
			components.read;
		if (semantic > 0.55) reasons.push('Matches your reading interests');
		if (tagAff > 0.4) reasons.push('Matches topics you follow');
		if (feedAff > 0.4) reasons.push('From a feed you read often');
		if (authorAff > 0.4) reasons.push('From an author you read');
		if (fresh > 0.85) reasons.push('Fresh story');
		if (!c.isRead) reasons.push('Unread');
	}
	components.exploration = EXPLORATION_WEIGHT * explorationBoost;
	score += components.exploration;

	return { id: c.id, score, reasons: reasons.slice(0, 3), components };
}

/** Normalized title key for cheap exact-duplicate grouping. */
export function canonicalTitleKey(title: string | null | undefined): string {
	if (!title) return '';
	return title
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 100);
}

export interface RankItem {
	id: number;
	feedId: number;
	score: number;
	embedding?: number[] | null;
	topics?: string[];
	titleKey?: string;
}

/**
 * Collapse near-duplicates: same canonical title, or embedding cosine at
 * or above threshold. Keeps the highest-scoring item per group (input order
 * after a score sort — callers should pre-sort, rankWithMMR does).
 */
export function collapseNearDuplicates(
	items: RankItem[],
	threshold = DEDUP_SIM_THRESHOLD
): RankItem[] {
	const kept: RankItem[] = [];
	for (const item of items) {
		let dup = false;
		for (const other of kept) {
			if (item.titleKey && other.titleKey && item.titleKey === other.titleKey) {
				dup = true;
				break;
			}
			if (item.embedding && other.embedding) {
				if (cosineSimilarity(item.embedding, other.embedding) >= threshold) {
					dup = true;
					break;
				}
			}
		}
		if (!dup) kept.push(item);
	}
	return kept;
}

export interface MmrOptions {
	lambda?: number;
	perFeedCap?: number;
	perTopicCap?: number;
	dupThreshold?: number;
}

/**
 * MMR rerank: greedily pick the item maximizing
 * λ·score − (1−λ)·maxSimilarityToPicked, subject to per-feed and per-topic
 * caps. Caps relax (topics first, then feeds) if the list can't be filled,
 * so the output is always a permutation of the deduped input.
 */
export function rankWithMMR(items: RankItem[], opts: MmrOptions = {}): number[] {
	const {
		lambda = MMR_LAMBDA,
		perFeedCap = 3,
		perTopicCap = 2,
		dupThreshold = DEDUP_SIM_THRESHOLD
	} = opts;
	const remaining = collapseNearDuplicates(
		[...items].sort((a, b) => b.score - a.score),
		dupThreshold
	);
	const picked: RankItem[] = [];
	const feedCounts = new Map<number, number>();
	const topicCounts = new Map<string, number>();
	const topicsOf = (it: RankItem): string[] =>
		(it.topics ?? []).map((t) => t.toLowerCase()).filter(Boolean);
	const violates = (it: RankItem, relaxFeed: boolean, relaxTopic: boolean): boolean => {
		if (!relaxFeed && (feedCounts.get(it.feedId) ?? 0) >= perFeedCap) return true;
		if (!relaxTopic) {
			for (const t of topicsOf(it)) {
				if ((topicCounts.get(t) ?? 0) >= perTopicCap) return true;
			}
		}
		return false;
	};
	const pairSim = (a: RankItem, b: RankItem): number => {
		if (a.embedding && b.embedding) return Math.max(0, cosineSimilarity(a.embedding, b.embedding));
		return 0;
	};

	let relaxTopic = false;
	let relaxFeed = false;
	while (remaining.length > 0) {
		let bestIdx = -1;
		let bestVal = -Infinity;
		for (let i = 0; i < remaining.length; i++) {
			const it = remaining[i];
			if (violates(it, relaxFeed, relaxTopic)) continue;
			let maxSim = 0;
			for (const p of picked) {
				const s = pairSim(it, p);
				if (s > maxSim) maxSim = s;
			}
			const val = lambda * it.score - (1 - lambda) * maxSim;
			if (val > bestVal) {
				bestVal = val;
				bestIdx = i;
			}
		}
		if (bestIdx < 0) {
			if (!relaxTopic) {
				relaxTopic = true;
				continue;
			}
			if (!relaxFeed) {
				relaxFeed = true;
				continue;
			}
			bestIdx = 0;
		}
		const [next] = remaining.splice(bestIdx, 1);
		picked.push(next);
		feedCounts.set(next.feedId, (feedCounts.get(next.feedId) ?? 0) + 1);
		for (const t of topicsOf(next)) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
	}
	return picked.map((i) => i.id);
}

/**
 * Rank scored candidates with a light diversity pass: after 3 picks from the
 * same feed in the top window, further items from that feed are deferred one
 * round so the feed doesn't monopolize the list.
 */
export function rankScored(ids: { id: number; feedId: number; score: number }[]): number[] {
	return rankWithMMR(
		ids.map((i) => ({ id: i.id, feedId: i.feedId, score: i.score })),
		{ lambda: 1 }
	);
}

/**
 * Tiny deterministic k-means for the interest model: cluster weighted
 * article embeddings into k centroids (multi-interest user model). Init
 * seeds are the top-k by weight; empty/dim-mismatched inputs are skipped.
 */
export function clusterVectors(
	vectors: number[][],
	weights: number[],
	k = INTEREST_CENTROIDS,
	iters = 12
): number[][] {
	const pts: { v: number[]; w: number }[] = [];
	for (let i = 0; i < vectors.length; i++) {
		const v = vectors[i];
		const w = weights[i] ?? 0;
		if (!Number.isFinite(w) || w <= 0) continue;
		if (!Array.isArray(v) || v.length === 0 || !v.every((x) => Number.isFinite(x))) continue;
		pts.push({ v, w });
	}
	if (pts.length === 0) return [];
	const dim = pts[0].v.length;
	const valid = pts.filter((p) => p.v.length === dim);
	if (valid.length === 0) return [];
	const order = [...valid].sort((a, b) => b.w - a.w);
	const seeds = order.slice(0, Math.min(k, order.length)).map((p) => [...p.v]);
	let centroids = seeds;
	for (let it = 0; it < iters; it++) {
		const acc = centroids.map(() => Array.from({ length: dim }, () => 0));
		const accW = centroids.map(() => 0);
		for (const p of valid) {
			let best = 0;
			let bestD = Infinity;
			for (let c = 0; c < centroids.length; c++) {
				let d = 0;
				for (let dI = 0; dI < dim; dI++) {
					const diff = p.v[dI] - centroids[c][dI];
					d += diff * diff;
				}
				if (d < bestD) {
					bestD = d;
					best = c;
				}
			}
			for (let dI = 0; dI < dim; dI++) acc[best][dI] += p.v[dI] * p.w;
			accW[best] += p.w;
		}
		const next = centroids.map((c, i) => {
			if (accW[i] <= 0) return [...c];
			const mean = acc[i].map((x) => x / accW[i]);
			const norm = Math.sqrt(mean.reduce((s, x) => s + x * x, 0));
			return norm > 0 ? mean.map((x) => x / norm) : mean;
		});
		centroids = next;
	}
	return centroids;
}

/** NDCG@k for the offline eval harness (1 = perfect ranking). */
export function ndcgAtK(rankedIds: number[], relevant: Set<number>, k: number): number {
	if (k <= 0 || relevant.size === 0) return 0;
	const top = rankedIds.slice(0, k);
	let dcg = 0;
	for (let i = 0; i < top.length; i++) {
		if (relevant.has(top[i])) dcg += 1 / Math.log2(i + 2);
	}
	const ideal = Math.min(k, relevant.size);
	let idcg = 0;
	for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
	return idcg === 0 ? 0 : dcg / idcg;
}
