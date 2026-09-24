import { describe, expect, it } from 'vitest';
import { similarityToInterest } from './enrich';

describe('similarityToInterest', () => {
	it('matches the best centroid for multi-interest users', () => {
		const tech: number[] = [1, 0];
		const food: number[] = [0, 1];
		// Tech article matches the tech centroid even though the food
		// centroid is far — no mushy-middle averaging.
		expect(similarityToInterest(tech, [tech, food])).toBeCloseTo(1);
		expect(similarityToInterest(food, [tech, food])).toBeCloseTo(1);
	});

	it('still reads legacy single-vector interest rows', () => {
		expect(similarityToInterest([1, 0], [1, 0])).toBeCloseTo(1);
		expect(similarityToInterest([1, 0], [0, 1])).toBeCloseTo(0);
	});

	it('returns null when either side is missing', () => {
		expect(similarityToInterest(null, [[1, 0]])).toBeNull();
		expect(similarityToInterest([1, 0], null)).toBeNull();
		expect(similarityToInterest([1, 0], [])).toBeNull();
	});
});
