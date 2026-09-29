import { describe, expect, it, vi } from 'vitest';
import {
	MAX_TOPICS,
	MIN_TOPIC_SIM,
	TOPIC_TAXONOMY,
	_resetTopicsForTests,
	classifyArticleTopics,
	classifyByVectors,
	classifyKeywordTopics,
	topicProbeText
} from './topics';

describe('topic taxonomy', () => {
	it('has unique ids and labels', () => {
		const ids = TOPIC_TAXONOMY.map((t) => t.id);
		const labels = TOPIC_TAXONOMY.map((t) => t.label);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(labels).size).toBe(labels.length);
		expect(TOPIC_TAXONOMY.length).toBeGreaterThanOrEqual(20);
	});
});

describe('classifyKeywordTopics', () => {
	it('summarises body content even when the title is generic', () => {
		// Title says nothing; body is clearly about geothermal power.
		const out = classifyKeywordTopics(
			'Daily roundup',
			'Menengai geothermal expansion adds capacity. The geothermal plant output ' +
				'feeds the national grid through Ketraco lines. Kenya Power confirmed the new megawatt output.'
		);
		expect(out).toContain('energy & power');
		expect(out.length).toBeLessThanOrEqual(MAX_TOPICS);
	});

	it('maps paraphrases onto the same bucket', () => {
		const a = classifyKeywordTopics(
			'GPU data-center buildout surges',
			'Hyperscalers are racing to add data center capacity for AI workloads, buying every GPU Nvidia can ship.'
		);
		const b = classifyKeywordTopics(
			'NVIDIA AI chips sell out',
			'Nvidia AI chips remain sold out as data center operators expand compute capacity for AI models.'
		);
		expect(a[0]).toBe(b[0]);
		expect(a[0]).toBe('ai infrastructure');
	});

	it('returns [] when unsure instead of guessing', () => {
		expect(classifyKeywordTopics('The and of', 'This is a the and')).toEqual([]);
		expect(classifyKeywordTopics('', '')).toEqual([]);
	});

	it('needs two distinct hits on very short texts (no single-word misfires)', () => {
		expect(classifyKeywordTopics('Tool', 'The trade war escalates daily.')).toEqual([]);
	});
});

describe('classifyByVectors', () => {
	it('returns top labels above threshold, capped at limit', () => {
		const topicVecs = new Map<string, number[]>([
			['ai infrastructure', [1, 0]],
			['sports', [0, 1]]
		]);
		expect(classifyByVectors([1, 0], topicVecs, 2, MIN_TOPIC_SIM)).toEqual(['ai infrastructure']);
		expect(classifyByVectors(null, topicVecs)).toEqual([]);
		expect(classifyByVectors([0, 0], topicVecs)).toEqual([]);
	});
});

describe('classifyArticleTopics', () => {
	it('falls back to keywords when no vector is available', async () => {
		_resetTopicsForTests();
		const out = await classifyArticleTopics(
			{
				title: 'Daily roundup',
				text: 'Menengai geothermal expansion adds capacity to the grid.',
				vector: null
			},
			2,
			async () => [null]
		);
		// Menengai-specific bucket wins over the generic energy one.
		expect(out).toContain('kenya energy & infrastructure');
	});

	it('uses semantic vectors when available', async () => {
		_resetTopicsForTests();
		const embed = vi.fn(async (texts: string[]) =>
			texts.map((t) => (t.includes('sports') ? [0, 1] : t.includes('TODAY') ? [0.1, 0.99] : [0, 1]))
		);
		const out = await classifyArticleTopics(
			{ title: 'TODAY', text: 'match report', vector: [0, 1] },
			2,
			embed,
			'test-model'
		);
		expect(embed).toHaveBeenCalled();
		expect(out.length).toBeGreaterThan(0);
		expect(topicProbeText(TOPIC_TAXONOMY[0]).length).toBeGreaterThan(10);
	});
});
