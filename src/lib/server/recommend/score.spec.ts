import { describe, expect, it } from 'vitest';
import {
	SEARCH_KEYWORD_BOOST,
	buildAffinityMaps,
	canonicalTitleKey,
	clusterVectors,
	collapseNearDuplicates,
	cosineSimilarity,
	deterministicExploreBoost,
	freshnessScore,
	idfWeight,
	interactionWeight,
	keywordMatchBoost,
	ndcgAtK,
	qualityScore,
	rankScored,
	rankWithMMR,
	readGrade,
	saturate,
	scoreCandidate,
	tagAffinity,
	timeDecay
} from './score';

describe('freshnessScore', () => {
	it('scores fresh stories near 1 and old stories near the floor', () => {
		const now = Date.now();
		expect(freshnessScore(new Date(now - 3600000), now)).toBeGreaterThan(0.9);
		// Gentle first-72h regime: a day old is still clearly fresh.
		expect(freshnessScore(new Date(now - 24 * 3600000), now)).toBeGreaterThan(0.8);
		// Two-week-old items decay hard but stay above the floor.
		const old = freshnessScore(new Date(now - 14 * 86400000), now);
		expect(old).toBeLessThan(0.12);
		expect(old).toBeGreaterThanOrEqual(0.08);
		expect(freshnessScore(null, now)).toBe(0.4);
	});
});

describe('cosineSimilarity', () => {
	it('returns 1 for identical vectors and 0 for mismatches', () => {
		expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
		expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
		expect(cosineSimilarity([], [])).toBe(0);
		expect(cosineSimilarity([1], [1, 2])).toBe(0);
	});
});

describe('timeDecay', () => {
	it('is 1 at age 0 and halves per half-life', () => {
		expect(timeDecay(0)).toBe(1);
		expect(timeDecay(-100)).toBe(1);
		expect(timeDecay(30 * 86400000)).toBeCloseTo(0.5, 5);
		expect(timeDecay(60 * 86400000)).toBeCloseTo(0.25, 5);
	});
});

describe('interactionWeight', () => {
	it('rewards deep engagement over a bare open', () => {
		const skim = interactionWeight({ openCount: 1, isRead: true });
		const deep = interactionWeight({
			openCount: 2,
			isRead: true,
			finished: true,
			isSaved: true,
			totalDwellMs: 120000,
			maxScrollPct: 90
		});
		expect(deep).toBeGreaterThan(skim);
		expect(skim).toBeGreaterThan(0);
	});

	it('returns negative for bounces', () => {
		expect(
			interactionWeight({ openCount: 1, isRead: true, totalDwellMs: 3000, maxScrollPct: 10 })
		).toBeLessThan(0);
	});

	it('does not bounce finished or saved articles', () => {
		expect(
			interactionWeight({ openCount: 1, isRead: true, finished: true, totalDwellMs: 1000 })
		).toBeGreaterThan(0);
	});

	it('returns 0 for no engagement', () => {
		expect(interactionWeight({})).toBe(0);
	});

	it('gives pure auto-reads zero weight so they never shape affinity', () => {
		// The list auto-marks its first article read on every page load
		// without the user opening it (openCount 0, no telemetry).
		expect(interactionWeight({ isRead: true })).toBe(0);
		expect(interactionWeight({ isRead: true, openCount: 0 })).toBe(0);
		// Any genuine engagement evidence still counts.
		expect(interactionWeight({ isRead: true, openCount: 1 })).toBeGreaterThan(0);
		expect(interactionWeight({ isRead: true, finished: true })).toBeGreaterThan(0);
	});
});

describe('saturate', () => {
	it('bounds output to 0..1 with diminishing returns', () => {
		expect(saturate(0, 5)).toBe(0);
		expect(saturate(-3, 5)).toBe(0);
		expect(saturate(5, 5)).toBeCloseTo(0.5);
		expect(saturate(1000, 5)).toBeLessThan(1);
		expect(saturate(1000, 5)).toBeGreaterThan(saturate(100, 5));
	});
});

describe('idfWeight', () => {
	it('downweights ubiquitous tags', () => {
		const rare = idfWeight(1, 100);
		const common = idfWeight(90, 100);
		expect(rare).toBeGreaterThan(common);
		expect(rare).toBeLessThanOrEqual(1);
		expect(common).toBeGreaterThanOrEqual(0);
		expect(idfWeight(5, 0)).toBe(1);
	});
});

describe('tagAffinity', () => {
	it('takes the mean of the top-2 matches', () => {
		const scores = new Map([
			['a', 1],
			['b', 0.5],
			['c', 0]
		]);
		// (1 + 0.5) / 2 — a third non-matching tag adds nothing.
		expect(tagAffinity(['a', 'b', 'zzz'], scores)).toBeCloseTo(0.75);
		expect(tagAffinity(['zzz'], scores)).toBe(0);
		expect(tagAffinity([], scores)).toBe(0);
	});

	it('applies IDF so generic tags contribute less', () => {
		const scores = new Map([['news', 1]]);
		const noIdf = tagAffinity(['news'], scores);
		const withIdf = tagAffinity(['news'], scores, () => 0.1);
		expect(withIdf).toBeCloseTo(noIdf * 0.1);
	});
});

describe('readGrade', () => {
	it('grades unread > finished > skimmed > bounced', () => {
		const unread = readGrade({ isRead: false, isSaved: false });
		const finished = readGrade({ isRead: true, isSaved: false, finished: true });
		const skimmed = readGrade({ isRead: true, isSaved: false, dwellMs: 60000, scrollPct: 50 });
		const bounced = readGrade({ isRead: true, isSaved: false, dwellMs: 2000, scrollPct: 5 });
		expect(unread).toBe(1);
		expect(finished).toBeGreaterThan(skimmed);
		expect(skimmed).toBeGreaterThan(bounced);
	});

	it('strongly demotes skimmed reads so opened stories sink below unseen ones', () => {
		// Unread-vs-skimmed gap must be large enough to survive affinity noise.
		expect(readGrade({ isRead: false, isSaved: false })).toBe(1);
		expect(readGrade({ isRead: true, isSaved: false, dwellMs: 60000, scrollPct: 50 })).toBeLessThan(
			0.2
		);
	});
});

describe('qualityScore', () => {
	it('prefers illustrated, substantial articles', () => {
		const good = qualityScore({ hasImage: true, excerptLength: 500, titleLength: 60 });
		const thin = qualityScore({ hasImage: false, excerptLength: 10, titleLength: 5 });
		expect(good).toBeGreaterThan(thin);
		expect(good).toBeLessThanOrEqual(1);
		expect(thin).toBeGreaterThanOrEqual(0);
	});
});

describe('keywordMatchBoost', () => {
	it('boosts exact keyword hits across title, excerpt and author', () => {
		expect(keywordMatchBoost('nvidia', { title: 'NVIDIA unveils new chips', excerpt: null })).toBe(
			SEARCH_KEYWORD_BOOST
		);
		expect(keywordMatchBoost('chips', { title: null, excerpt: 'AI chips explained' })).toBe(
			SEARCH_KEYWORD_BOOST
		);
		expect(keywordMatchBoost('ars', { author: 'Ars Technica' })).toBe(SEARCH_KEYWORD_BOOST);
	});

	it('gives partial credit for multi-token partial matches', () => {
		const full = keywordMatchBoost('new chips', { title: 'NVIDIA unveils new chips' });
		expect(full).toBe(SEARCH_KEYWORD_BOOST);
		const partial = keywordMatchBoost('nvidia quantum', { title: 'NVIDIA unveils new chips' });
		expect(partial).toBeGreaterThan(0);
		expect(partial).toBeLessThan(SEARCH_KEYWORD_BOOST);
	});

	it('is case-insensitive and trims the query', () => {
		expect(keywordMatchBoost('  NVIDIA  ', { title: 'nvidia news' })).toBe(SEARCH_KEYWORD_BOOST);
	});

	it('returns 0 for misses and empty queries', () => {
		expect(keywordMatchBoost('quantum', { title: 'NVIDIA news' })).toBe(0);
		expect(keywordMatchBoost('', { title: 'anything' })).toBe(0);
		expect(keywordMatchBoost(null, { title: 'anything' })).toBe(0);
		expect(keywordMatchBoost('x', {})).toBe(0);
	});
});

describe('deterministicExploreBoost', () => {
	it('is stable within a day and varies across users/articles', () => {
		const now = Date.now();
		expect(deterministicExploreBoost('u1', 7, now)).toBe(deterministicExploreBoost('u1', 7, now));
		const vals = new Set(
			Array.from({ length: 200 }, (_, i) => deterministicExploreBoost('u1', i, now))
		);
		// Roughly 8% get the slot — some do, most don't.
		expect(vals.has(1)).toBe(true);
		expect(vals.has(0)).toBe(true);
	});

	it('is stable for the same seed and reshuffles with a new seed', () => {
		const now = Date.now();
		expect(deterministicExploreBoost('u1', 7, now, 'a')).toBe(
			deterministicExploreBoost('u1', 7, now, 'a')
		);
		const before = Array.from({ length: 200 }, (_, i) =>
			deterministicExploreBoost('u1', i, now, 'seed-1')
		);
		const after = Array.from({ length: 200 }, (_, i) =>
			deterministicExploreBoost('u1', i, now, 'seed-2')
		);
		// Both seeds elect some exploration items, but not the same set.
		expect(before).toContain(1);
		expect(after).toContain(1);
		expect(before).not.toEqual(after);
	});
});

describe('scoreCandidate', () => {
	it('prefers unread stories from familiar feeds', () => {
		const aff = buildAffinityMaps({
			feedCounts: new Map([[7, 10]]),
			tagCounts: new Map(),
			authorCounts: new Map()
		});
		const now = Date.now();
		const familiar = scoreCandidate(
			{
				id: 1,
				feedId: 7,
				author: null,
				publishedAt: new Date(now - 3600000),
				isRead: false,
				isSaved: false,
				tags: []
			},
			aff,
			{ now, explorationBoost: 0 }
		);
		const stranger = scoreCandidate(
			{
				id: 2,
				feedId: 9,
				author: null,
				publishedAt: new Date(now - 3600000),
				isRead: false,
				isSaved: false,
				tags: []
			},
			aff,
			{ now, explorationBoost: 0 }
		);
		expect(familiar.score).toBeGreaterThan(stranger.score);
	});

	it('demotes read stories without burying finished ones', () => {
		const aff = buildAffinityMaps({
			feedCounts: new Map(),
			tagCounts: new Map(),
			authorCounts: new Map()
		});
		const now = Date.now();
		const base = {
			feedId: 1,
			author: null,
			publishedAt: new Date(now - 3600000),
			isSaved: false,
			tags: []
		};
		const unread = scoreCandidate({ ...base, id: 1, isRead: false }, aff, { now });
		const finished = scoreCandidate({ ...base, id: 2, isRead: true, finished: true }, aff, { now });
		const bounced = scoreCandidate(
			{ ...base, id: 3, isRead: true, dwellMs: 2000, scrollPct: 5 },
			aff,
			{ now }
		);
		expect(unread.score).toBeGreaterThan(finished.score);
		expect(finished.score).toBeGreaterThan(bounced.score);
	});

	it('ignores feed affinity in search mode', () => {
		const aff = buildAffinityMaps({
			feedCounts: new Map([[7, 50]]),
			tagCounts: new Map(),
			authorCounts: new Map()
		});
		const now = Date.now();
		const base = {
			author: null,
			publishedAt: new Date(now - 3600000),
			isRead: false,
			isSaved: false,
			tags: [],
			semanticSimilarity: 0.5
		};
		const fromFav = scoreCandidate({ ...base, id: 1, feedId: 7 }, aff, {
			now,
			mode: 'search'
		});
		const fromStranger = scoreCandidate({ ...base, id: 2, feedId: 9 }, aff, {
			now,
			mode: 'search'
		});
		expect(fromFav.score).toBeCloseTo(fromStranger.score, 10);
	});
});

describe('semantic blend', () => {
	it('boosts score and explains when similarity is present', () => {
		const aff = buildAffinityMaps({
			feedCounts: new Map(),
			tagCounts: new Map(),
			authorCounts: new Map()
		});
		const now = Date.now();
		const base = {
			id: 1,
			feedId: 1,
			author: null,
			publishedAt: new Date(now - 3600000),
			isRead: false,
			isSaved: false,
			tags: []
		};
		const plain = scoreCandidate(base, aff, { now });
		const semantic = scoreCandidate({ ...base, semanticSimilarity: 0.9 }, aff, { now });
		expect(semantic.score).toBeGreaterThan(plain.score);
		expect(semantic.reasons).toContain('Matches your reading interests');
	});
});

describe('canonicalTitleKey', () => {
	it('normalizes titles for duplicate grouping', () => {
		expect(canonicalTitleKey('Hello,  World!')).toBe(canonicalTitleKey('hello world'));
		expect(canonicalTitleKey(null)).toBe('');
	});
});

describe('collapseNearDuplicates', () => {
	it('keeps the highest-scoring item per duplicate group', () => {
		const out = collapseNearDuplicates(
			[
				{ id: 1, feedId: 1, score: 0.9, embedding: [1, 0], titleKey: 'a' },
				{ id: 2, feedId: 2, score: 0.8, embedding: [1, 0.01], titleKey: 'b' },
				{ id: 3, feedId: 3, score: 0.7, embedding: [0, 1], titleKey: 'c' }
			],
			0.99
		);
		expect(out.map((i) => i.id)).toEqual([1, 3]);
	});

	it('collapses identical titles without embeddings', () => {
		const out = collapseNearDuplicates([
			{ id: 1, feedId: 1, score: 0.9, titleKey: 'same story' },
			{ id: 2, feedId: 2, score: 0.8, titleKey: 'same story' }
		]);
		expect(out.map((i) => i.id)).toEqual([1]);
	});
});

describe('rankWithMMR', () => {
	it('penalizes near-identical neighbors without hiding them forever', () => {
		const ids = rankWithMMR(
			[
				{ id: 1, feedId: 1, score: 0.95, embedding: [1, 0], topics: ['ai'] },
				{ id: 2, feedId: 2, score: 0.9, embedding: [0.88, 0.475], topics: ['ai'] },
				{ id: 3, feedId: 3, score: 0.6, embedding: [0, 1], topics: ['cooking'] }
			],
			{ lambda: 0.5, perFeedCap: 5, perTopicCap: 5 }
		);
		// Diverse mid-relevance beats a near-dup of the top pick.
		expect(ids[0]).toBe(1);
		expect(ids[1]).toBe(3);
		expect(ids).toContain(2);
	});

	it('enforces per-topic caps then relaxes to finish the list', () => {
		const ids = rankWithMMR(
			[
				{ id: 1, feedId: 1, score: 0.9, topics: ['ai'] },
				{ id: 2, feedId: 2, score: 0.8, topics: ['ai'] },
				{ id: 3, feedId: 3, score: 0.7, topics: ['ai'] }
			],
			{ lambda: 1, perFeedCap: 5, perTopicCap: 1 }
		);
		expect(ids.length).toBe(3);
		expect(ids[0]).toBe(1);
	});
});

describe('rankScored', () => {
	it('defers feed monopolies past 3 picks', () => {
		const ids = rankScored([
			{ id: 1, feedId: 1, score: 0.9 },
			{ id: 2, feedId: 1, score: 0.8 },
			{ id: 3, feedId: 1, score: 0.7 },
			{ id: 4, feedId: 1, score: 0.6 },
			{ id: 5, feedId: 2, score: 0.5 }
		]);
		expect(ids.slice(0, 4)).toEqual([1, 2, 3, 5]);
		expect(ids[4]).toBe(4);
	});
});

describe('clusterVectors', () => {
	it('separates two clear interest clusters', () => {
		const tech: number[][] = [
			[1, 0.05],
			[0.99, 0.08],
			[0.98, 0.02]
		];
		const food: number[][] = [
			[0.05, 1],
			[0.08, 0.99]
		];
		const centroids = clusterVectors([...tech, ...food], [3, 2, 1, 3, 2], 2);
		expect(centroids).toHaveLength(2);
		// One centroid near tech, one near food (order not guaranteed).
		const sims = centroids.map((c) => cosineSimilarity(c, [1, 0]));
		expect(Math.max(...sims)).toBeGreaterThan(0.9);
		expect(Math.min(...sims)).toBeLessThan(0.5);
	});

	it('returns [] for empty or invalid input', () => {
		expect(clusterVectors([], [])).toEqual([]);
		expect(clusterVectors([[]], [1])).toEqual([]);
		expect(clusterVectors([[1, 0]], [0])).toEqual([]);
	});
});

describe('ndcgAtK', () => {
	it('is 1 for perfect rankings and 0 for empty relevance', () => {
		expect(ndcgAtK([1, 2, 3], new Set([1, 2, 3]), 3)).toBeCloseTo(1);
		expect(ndcgAtK([4, 5], new Set([1]), 2)).toBe(0);
		expect(ndcgAtK([1], new Set(), 1)).toBe(0);
	});

	it('rewards relevant items earlier in the list', () => {
		expect(ndcgAtK([1, 9], new Set([1]), 2)).toBeGreaterThan(ndcgAtK([9, 1], new Set([1]), 2));
	});
});
