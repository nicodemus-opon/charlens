import { describe, expect, it } from 'vitest';
import {
	findPrunableJunkTags,
	getTagConsolidateIntervalH,
	getTagConsolidateMaxMergesPerUser,
	getTagConsolidateMaxUsers,
	getTagConsolidateMinSimilarity,
	isTagConsolidateEnabled,
	planSemanticMerges,
	planStringMerges,
	shouldRunConsolidation
} from './consolidate';

describe('isTagConsolidateEnabled', () => {
	it('defaults on, 0 disables', () => {
		expect(isTagConsolidateEnabled(undefined)).toBe(true);
		expect(isTagConsolidateEnabled('0')).toBe(false);
		expect(isTagConsolidateEnabled('1')).toBe(true);
	});
});

describe('consolidate env parsing', () => {
	it('clamps ranges', () => {
		expect(getTagConsolidateIntervalH('0')).toBe(1);
		expect(getTagConsolidateIntervalH('999')).toBe(168);
		expect(getTagConsolidateIntervalH('bogus')).toBe(24);
		expect(getTagConsolidateMaxUsers('0')).toBe(1);
		expect(getTagConsolidateMaxMergesPerUser('999')).toBe(50);
		expect(getTagConsolidateMinSimilarity('0.1')).toBe(0.8);
		expect(getTagConsolidateMinSimilarity('1.5')).toBe(0.99);
		expect(getTagConsolidateMinSimilarity('bogus')).toBe(0.92);
	});
});

describe('shouldRunConsolidation', () => {
	it('runs when never ran', () => {
		expect(shouldRunConsolidation(null)).toBe(true);
		expect(shouldRunConsolidation('not-a-date')).toBe(true);
	});

	it('gates on the interval', () => {
		const now = Date.now();
		const recent = new Date(now - 60_000).toISOString();
		const old = new Date(now - 25 * 60 * 60 * 1000).toISOString();
		expect(shouldRunConsolidation(recent, now, 24)).toBe(false);
		expect(shouldRunConsolidation(old, now, 24)).toBe(true);
	});
});

describe('planStringMerges', () => {
	it('merges singular/plural dups into the lowest id', () => {
		const plans = planStringMerges([
			{ id: 7, name: 'coding agents' },
			{ id: 3, name: 'coding agent' }
		]);
		expect(plans).toHaveLength(1);
		expect(plans[0].winnerId).toBe(3);
		expect(plans[0].loserId).toBe(7);
		expect(plans[0].reason).toBe('singular');
	});

	it('merges word-order variants', () => {
		const plans = planStringMerges([
			{ id: 1, name: 'coding agent' },
			{ id: 2, name: 'agent coding' }
		]);
		expect(plans).toHaveLength(1);
		expect(plans[0].reason).toBe('bag');
	});

	it('leaves distinct tags alone', () => {
		expect(
			planStringMerges([
				{ id: 1, name: 'nvidia' },
				{ id: 2, name: 'amd' }
			])
		).toEqual([]);
	});

	it('merges each loser once', () => {
		const plans = planStringMerges([
			{ id: 1, name: 'coding agent' },
			{ id: 2, name: 'coding agents' },
			{ id: 3, name: 'agent coding' }
		]);
		expect(plans).toHaveLength(2);
		expect(new Set(plans.map((p) => p.loserId)).size).toBe(2);
	});
});

describe('planSemanticMerges', () => {
	it('skips string-dup pairs (string pass owns them)', () => {
		const tags = [
			{ id: 1, name: 'coding agent', enrichUses: 2 },
			{ id: 2, name: 'coding agents', enrichUses: 5 }
		];
		const vectors = new Map([
			[1, [1, 0]],
			[2, [1, 0]]
		]);
		expect(planSemanticMerges(tags, vectors, 0.9)).toEqual([]);
	});

	it('picks the higher-use tag as winner', () => {
		const tags = [
			{ id: 1, name: 'llm', enrichUses: 2 },
			{ id: 2, name: 'large language model', enrichUses: 5 }
		];
		// cosine([1,0],[0.99,0.141]) ≈ 0.99
		const vectors = new Map([
			[1, [1, 0]],
			[2, [0.99, 0.141]]
		]);
		const plans = planSemanticMerges(tags, vectors, 0.9);
		expect(plans).toHaveLength(1);
		expect(plans[0].winnerId).toBe(2);
		expect(plans[0].reason).toBe('semantic');
		expect(plans[0].similarity).toBeGreaterThan(0.9);
	});

	it('ignores below-threshold pairs', () => {
		const tags = [
			{ id: 1, name: 'nvidia', enrichUses: 3 },
			{ id: 2, name: 'cooking', enrichUses: 3 }
		];
		expect(tags).toHaveLength(2);
		const vectors = new Map([
			[1, [1, 0]],
			[2, [0, 1]]
		]);
		expect(planSemanticMerges(tags, vectors, 0.9)).toEqual([]);
	});
});

describe('findPrunableJunkTags', () => {
	it('only prunes low-use junk with no protected links', () => {
		const out = findPrunableJunkTags([
			{ id: 1, name: '3 hrs ago', enrichUses: 1, protectedUses: 0 },
			{ id: 2, name: '3 hrs ago', enrichUses: 5, protectedUses: 0 },
			{ id: 3, name: 'page', enrichUses: 1, protectedUses: 2 },
			{ id: 4, name: 'nvidia', enrichUses: 1, protectedUses: 0 }
		]);
		expect(out.map((t) => t.id)).toEqual([1]);
	});
});
