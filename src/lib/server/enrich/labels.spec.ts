import { describe, expect, it } from 'vitest';
import { AUTO_LABEL_BUDGET, buildLabelSet } from './labels';

describe('buildLabelSet', () => {
	it('puts taxonomy buckets first, specifics fill the rest', () => {
		const out = buildLabelSet({
			topics: ['ai infrastructure', 'semiconductors'],
			tags: ['nvidia', 'data center'],
			entities: ['NVIDIA']
		});
		expect(out[0]).toBe('ai infrastructure');
		expect(out[1]).toBe('semiconductors');
		expect(out).toContain('nvidia');
		// NVIDIA entity collapses into the nvidia tag.
		expect(out.filter((t) => t === 'nvidia').length).toBe(1);
	});

	it('collapses substring and word-order duplicates', () => {
		const out = buildLabelSet({
			topics: ['energy & power'],
			tags: ['power', 'power energy'],
			entities: []
		});
		// "power" is covered by the bucket; "power energy" is the same bag.
		expect(out).toEqual(['energy & power']);
	});

	it('caps at the budget', () => {
		const out = buildLabelSet(
			{
				topics: ['sports', 'media & journalism'],
				tags: ['marathon', 'olympics', 'fifa', 'trophy', 'stadium'],
				entities: []
			},
			3
		);
		expect(out).toEqual(['sports', 'media & journalism', 'marathon']);
	});

	it('limits taxonomy to two so specifics survive', () => {
		const out = buildLabelSet({
			topics: ['sports', 'media & journalism', 'entertainment & culture'],
			tags: ['marathon'],
			entities: []
		});
		expect(out).toContain('marathon');
		expect(out).not.toContain('entertainment & culture');
	});

	it('returns [] when unsure instead of junk', () => {
		expect(buildLabelSet({ topics: [], tags: [], entities: [] })).toEqual([]);
	});

	it('never exceeds the auto-label budget by default', () => {
		const out = buildLabelSet({
			topics: ['sports', 'media & journalism', 'entertainment & culture'],
			tags: ['marathon', 'olympics', 'fifa', 'trophy'],
			entities: ['World Athletics']
		});
		expect(out.length).toBeLessThanOrEqual(AUTO_LABEL_BUDGET);
	});
});
