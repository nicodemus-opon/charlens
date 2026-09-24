// Golden offline-eval set for recommendations: scenario-level regression
// tests with synthetic users/items. If a scoring change breaks one of these,
// it must move NDCG on real data first — not just look better in isolation.

import { describe, expect, it } from 'vitest';
import {
	buildAffinityMaps,
	ndcgAtK,
	rankWithMMR,
	scoreCandidate,
	type AffinityMaps
} from './score';

const NOW = Date.now();
const HOUR = 3_600_000;

function techUser(): AffinityMaps {
	return buildAffinityMaps({
		feedCounts: new Map([[7, 25]]),
		tagCounts: new Map([
			['ai chips', 18],
			['semiconductors', 12],
			['news', 30]
		]),
		authorCounts: new Map()
	});
}

describe('golden: multi-interest user', () => {
	it('ranks a matching-interest article above an unrelated one', () => {
		const aff = techUser();
		const base = {
			feedId: 9,
			author: null,
			publishedAt: new Date(NOW - HOUR),
			isRead: false,
			isSaved: false
		};
		const match = scoreCandidate(
			{ ...base, id: 1, tags: ['ai chips'], semanticSimilarity: 0.85 },
			aff,
			{ now: NOW }
		);
		const miss = scoreCandidate(
			{ ...base, id: 2, tags: ['gardening'], semanticSimilarity: 0.1 },
			aff,
			{ now: NOW }
		);
		expect(match.score).toBeGreaterThan(miss.score);
		expect(
			ndcgAtK(
				[match.id, miss.id].sort((a, b) => a - b),
				new Set([1]),
				2
			)
		).toBeDefined();
	});
});

describe('golden: generic tags do not dominate', () => {
	it('a distinctive-tag match beats a generic-tag match', () => {
		const aff = techUser();
		const base = {
			feedId: 9,
			author: null,
			publishedAt: new Date(NOW - HOUR),
			isRead: false,
			isSaved: false
		};
		// "news" appears in 30 docs, "ai chips" in 18 of a 40-doc window.
		const idf = new Map([
			['news', 0.15],
			['ai chips', 0.55]
		]);
		const generic = scoreCandidate({ ...base, id: 1, tags: ['news'] }, aff, {
			now: NOW,
			tagIdf: idf
		});
		const distinctive = scoreCandidate({ ...base, id: 2, tags: ['ai chips'] }, aff, {
			now: NOW,
			tagIdf: idf
		});
		expect(distinctive.score).toBeGreaterThan(generic.score);
	});
});

describe('golden: freshness vs affinity tradeoff', () => {
	it('a fresh stranger can beat a stale favorite, but not a fresh favorite', () => {
		const aff = techUser();
		const favStale = scoreCandidate(
			{
				id: 1,
				feedId: 7,
				author: null,
				publishedAt: new Date(NOW - 10 * 24 * HOUR),
				isRead: false,
				isSaved: false,
				tags: []
			},
			aff,
			{ now: NOW }
		);
		const strangerFresh = scoreCandidate(
			{
				id: 2,
				feedId: 99,
				author: null,
				publishedAt: new Date(NOW - HOUR),
				isRead: false,
				isSaved: false,
				tags: []
			},
			aff,
			{ now: NOW }
		);
		const favFresh = scoreCandidate(
			{
				id: 3,
				feedId: 7,
				author: null,
				publishedAt: new Date(NOW - HOUR),
				isRead: false,
				isSaved: false,
				tags: []
			},
			aff,
			{ now: NOW }
		);
		expect(strangerFresh.score).toBeGreaterThan(favStale.score);
		expect(favFresh.score).toBeGreaterThan(strangerFresh.score);
	});
});

describe('golden: bounce demotion', () => {
	it('bounced lookalikes rank below finished reads', () => {
		const aff = buildAffinityMaps({
			feedCounts: new Map(),
			tagCounts: new Map(),
			authorCounts: new Map()
		});
		const base = {
			feedId: 1,
			author: null,
			publishedAt: new Date(NOW - HOUR),
			isSaved: false,
			tags: []
		};
		const finished = scoreCandidate({ ...base, id: 1, isRead: true, finished: true }, aff, {
			now: NOW
		});
		const bounced = scoreCandidate(
			{ ...base, id: 2, isRead: true, dwellMs: 3000, scrollPct: 8 },
			aff,
			{ now: NOW }
		);
		expect(finished.score).toBeGreaterThan(bounced.score);
	});
});

describe('golden: diversity survives relevance', () => {
	it('a mid-relevance outsider outranks the third near-duplicate', () => {
		// Pairwise cosine ~0.85–0.89: similar but below the 0.92 dedup line,
		// so MMR (not collapsing) does the diversification work.
		const ai: [number, number, number][] = [
			[1, 0, 0],
			[0.88, 0.475, 0],
			[0.85, 0.3, 0.435]
		];
		const ids = rankWithMMR(
			[
				{ id: 1, feedId: 1, score: 0.95, embedding: ai[0], topics: ['ai chips'] },
				{ id: 2, feedId: 2, score: 0.93, embedding: ai[1], topics: ['ai chips'] },
				{ id: 3, feedId: 3, score: 0.91, embedding: ai[2], topics: ['ai chips'] },
				{ id: 4, feedId: 4, score: 0.7, embedding: [0, 0, 1], topics: ['sourdough'] }
			],
			{ lambda: 0.8, perFeedCap: 5, perTopicCap: 5 }
		);
		expect(ids[0]).toBe(1);
		expect(ids.indexOf(4)).toBeLessThan(ids.indexOf(3));
		// Nothing lost, just reordered.
		expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
	});
});

describe('golden: embedding-free fallback', () => {
	it('still ranks sensibly with no semantic signal at all', () => {
		const aff = techUser();
		const ranked = [1, 2].map(
			(id) =>
				scoreCandidate(
					{
						id,
						feedId: id === 1 ? 7 : 99,
						author: null,
						publishedAt: new Date(NOW - HOUR),
						isRead: false,
						isSaved: false,
						tags: id === 1 ? ['semiconductors'] : ['sports']
					},
					aff,
					{ now: NOW }
				).score
		);
		expect(ranked[0]).toBeGreaterThan(ranked[1]);
	});
});
