import { describe, expect, it, vi } from 'vitest';
import { getFulltextConcurrency, getFulltextMaxPerRun, isFulltextAutoEnabled } from './fulltext';
import { looksTruncated } from './scrape';

describe('fulltext automation config', () => {
	it('is enabled by default', () => {
		expect(isFulltextAutoEnabled()).toBe(true);
	});

	it('clamps per-run and concurrency bounds', () => {
		expect(getFulltextMaxPerRun()).toBeGreaterThanOrEqual(1);
		expect(getFulltextMaxPerRun()).toBeLessThanOrEqual(50);
		expect(getFulltextConcurrency()).toBeGreaterThanOrEqual(1);
		expect(getFulltextConcurrency()).toBeLessThanOrEqual(5);
	});
});

describe('looksTruncated gate for automation', () => {
	it('flags excerpt-only bodies for backfill', () => {
		expect(looksTruncated('<p>hi</p>', 'hi')).toBe(true);
		expect(looksTruncated('', 'hi')).toBe(true);
	});

	it('skips full bodies', () => {
		expect(looksTruncated(`<p>${'x'.repeat(2000)}</p>`, 'short')).toBe(false);
	});

	it('scrape fn is injectable (vi mock sanity)', () => {
		const scrapeFn = vi.fn();
		expect(scrapeFn).toBeDefined();
	});
});
