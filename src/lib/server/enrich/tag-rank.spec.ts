import { describe, expect, it } from 'vitest';
import { MIN_SIM, rankTags, type EmbedBatch } from './tag-rank';

// 3-d toy vectors: candidates near the doc axis are on-topic, off-axis junk
// ("secure payments kenya") sits far away — exactly what MiniLM gives us for
// repeated scraper chrome.

const DOC = 'Geothermal power in Kenya. Menengai plants feed the grid.';

function stubEmbed(map: Record<string, number[]>): EmbedBatch {
	return async (texts) => texts.map((t) => map[t] ?? null);
}

describe('rankTags', () => {
	it('drops off-topic candidates below MIN_SIM instead of padding the budget', async () => {
		const embed = stubEmbed({
			[DOC]: [1, 0, 0],
			geothermal: [0.95, 0.05, 0],
			'secure payments kenya': [0.05, 0.95, 0],
			'flash sale': [0, 0.9, 0.1]
		});
		const out = await rankTags(
			['geothermal', 'secure payments kenya', 'flash sale'],
			{ title: 'Geothermal power in Kenya', text: 'Menengai plants feed the grid.' },
			5,
			embed
		);
		expect(out).toEqual(['geothermal']);
		expect(MIN_SIM).toBeGreaterThan(0.05 + 0.1); // junk + title boost still fails
	});

	it('returns [] when every candidate is junk (feed categories stand alone)', async () => {
		const embed = stubEmbed({
			[DOC]: [1, 0, 0],
			'secure payments kenya': [0, 1, 0],
			'flash sale': [0, 0.9, 0.1]
		});
		const out = await rankTags(
			['secure payments kenya', 'flash sale'],
			{ title: 'Geothermal power in Kenya', text: 'Menengai plants feed the grid.' },
			5,
			embed
		);
		expect(out).toEqual([]);
	});

	it('boosts title-anchored candidates over body-only ones', async () => {
		const embed = stubEmbed({
			[DOC]: [1, 0, 0],
			geothermal: [0.5, 0.5, 0], // in the title
			battery: [0.55, 0.45, 0] // body only, slightly higher raw sim
		});
		const out = await rankTags(
			['battery', 'geothermal'],
			{ title: 'Geothermal power in Kenya', text: 'Menengai plants feed the grid.' },
			2,
			embed
		);
		expect(out[0]).toBe('geothermal');
	});

	it('diversifies via MMR: near-duplicate tags never fill the budget', async () => {
		// A and A2 are the same topic (cos ~1); B is less relevant but distinct.
		// Title names none of them, so no TITLE_BOOST pollutes the math.
		const DOC2 = 'Kenya energy outlook. Menengai plants feed the grid.';
		const embed = stubEmbed({
			[DOC2]: [1, 0, 0],
			geothermal: [0.9, 0.436, 0],
			'geothermal power': [0.89, 0.456, 0],
			'grid storage': [0.8, 0, 0.6]
		});
		const out = await rankTags(
			['geothermal', 'geothermal power', 'grid storage'],
			{ title: 'Kenya energy outlook', text: 'Menengai plants feed the grid.' },
			2,
			embed
		);
		expect(out).toEqual(['geothermal', 'grid storage']);
	});

	it('falls back to heuristic order when the model is unavailable', async () => {
		const embed: EmbedBatch = async (texts) => texts.map(() => null);
		const out = await rankTags(
			['nvidia', 'ai chips', 'data centers'],
			{ title: 'NVIDIA unveils AI chips', text: 'Data centers deploy them.' },
			5,
			embed
		);
		expect(out).toEqual(['nvidia', 'ai chips', 'data centers']);
	});

	it('handles empty and duplicate candidates', async () => {
		expect(await rankTags([], { title: 'x', text: 'y' })).toEqual([]);
		const embed = stubEmbed({ [DOC]: [1, 0, 0], nvidia: [0.9, 0.1, 0] });
		const out = await rankTags(
			['NVIDIA', 'nvidia', ' nvidia '],
			{ title: 'Geothermal power in Kenya', text: 'Menengai plants feed the grid.' },
			5,
			embed
		);
		expect(out).toEqual(['nvidia']);
	});
});
