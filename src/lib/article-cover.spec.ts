import { describe, expect, it } from 'vitest';
import {
	COVER_BACKGROUNDS,
	COVER_BACKGROUNDS_DARK,
	COVER_SHAPES,
	COVER_SHAPES_DARK,
	articleSeedString,
	getCoverDataUri,
	isUsableCoverWidth
} from './article-cover.js';

describe('article-cover', () => {
	it('builds a stable seed string', () => {
		expect(articleSeedString({ id: 3, feedTitle: 'Feed', title: 'Title' })).toBe('3:Feed:Title');
	});

	it('returns the same data URI for the same article (SSR/client safe)', () => {
		const seed = { id: 7, feedTitle: 'Discovery', title: 'Hello' };
		const first = getCoverDataUri(seed);
		expect(first.startsWith('data:image/svg+xml')).toBe(true);
		expect(getCoverDataUri({ ...seed })).toBe(first);
	});

	it('varies the cover across articles', () => {
		const uris = new Set(
			['Alpha', 'Beta', 'Gamma', 'Delta'].map((feedTitle, i) =>
				getCoverDataUri({ id: i, feedTitle, title: 'Same' })
			)
		);
		expect(uris.size).toBeGreaterThan(1);
	});

	it('only uses the theme-harmonized palettes', () => {
		const check = (scheme: 'light' | 'dark', allowed: Set<string>) => {
			const decoded = decodeURIComponent(
				getCoverDataUri({ id: 1, feedTitle: 'Feed', title: 'Title' }, scheme).split(',', 2)[1]
			).toLowerCase();
			const hexes = [...decoded.matchAll(/#([0-9a-f]{6})/g)].map((m) => m[1]);
			expect(hexes.length).toBeGreaterThan(0);
			for (const hex of hexes) expect(allowed.has(hex)).toBe(true);
		};
		const light: Set<string> = new Set([...COVER_BACKGROUNDS, ...COVER_SHAPES]);
		const dark: Set<string> = new Set([...COVER_BACKGROUNDS_DARK, ...COVER_SHAPES_DARK]);
		check('light', light);
		check('dark', dark);
	});

	it('renders distinct covers per color scheme', () => {
		const seed = { id: 7, feedTitle: 'Discovery', title: 'Hello' };
		const light = getCoverDataUri(seed, 'light');
		const dark = getCoverDataUri(seed, 'dark');
		expect(dark.startsWith('data:image/svg+xml')).toBe(true);
		expect(dark).not.toBe(light);
		expect(getCoverDataUri({ ...seed }, 'dark')).toBe(dark);
	});

	it('rejects icon-sized remote covers so they fall back to generated art', () => {
		expect(isUsableCoverWidth(16)).toBe(false);
		expect(isUsableCoverWidth(64)).toBe(false);
		expect(isUsableCoverWidth(199)).toBe(false);
		expect(isUsableCoverWidth(200)).toBe(true);
		expect(isUsableCoverWidth(1200)).toBe(true);
	});
});
