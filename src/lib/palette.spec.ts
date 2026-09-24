import { describe, expect, it } from 'vitest';
import {
	articleHref,
	articlePaletteItems,
	collectionHref,
	feedHref,
	rankPaletteItems,
	relativeAge,
	scoreItem,
	scoreText,
	smartViewHref,
	tagHref
} from './palette';

describe('scoreText', () => {
	it('matches everything when the query is empty', () => {
		expect(scoreText('Anything', '   ')).toBe(1);
	});

	it('ranks exact matches highest', () => {
		expect(scoreText('Design', 'design')).toBe(1);
	});

	it('ranks prefixes above word and substring hits', () => {
		expect(scoreText('Designing', 'design')).toBeGreaterThan(scoreText('AI design', 'design'));
		expect(scoreText('AI design', 'design')).toBeGreaterThan(scoreText('redesign', 'design'));
	});

	it('is case and whitespace insensitive', () => {
		expect(scoreText('  AI   News ', 'ai news')).toBe(1);
	});

	it('falls back to subsequence fuzzy matches', () => {
		expect(scoreText('AI news daily', 'aind')).toBeGreaterThan(0);
	});

	it('returns 0 for misses and empty haystacks', () => {
		expect(scoreText('Design', 'zzz')).toBe(0);
		expect(scoreText('', 'design')).toBe(0);
	});
});

describe('scoreItem', () => {
	it('prefers label matches over hint matches', () => {
		const item = { label: 'Technology', hint: 'design weekly' };
		expect(scoreItem(item, 'technology')).toBeGreaterThan(scoreItem(item, 'design'));
	});

	it('matches on keywords', () => {
		const item = { label: 'Today', keywords: ['inbox', 'unread'] };
		expect(scoreItem(item, 'inbox')).toBeGreaterThan(0);
	});
});

describe('rankPaletteItems', () => {
	const items = [
		{ label: 'AI news' },
		{ label: 'design' },
		{ label: 'Design systems' },
		{ label: 'cooking' }
	];

	it('drops non-matches', () => {
		expect(rankPaletteItems(items, 'design').map((i) => i.label)).toEqual([
			'design',
			'Design systems'
		]);
	});

	it('returns every item, in order, for an empty query', () => {
		expect(rankPaletteItems(items, '').map((i) => i.label)).toEqual([
			'AI news',
			'design',
			'Design systems',
			'cooking'
		]);
	});

	it('caps each group at the limit', () => {
		expect(rankPaletteItems(items, '', 2)).toHaveLength(2);
	});

	it('keeps the original order for equal scores', () => {
		const ties = [{ label: 'aa' }, { label: 'ab' }, { label: 'ac' }];
		expect(rankPaletteItems(ties, 'a').map((i) => i.label)).toEqual(['aa', 'ab', 'ac']);
	});
});

describe('relativeAge', () => {
	const now = Date.parse('2026-01-10T12:00:00.000Z');

	it('formats minutes, hours and days', () => {
		expect(relativeAge('2026-01-10T11:30:00.000Z', now)).toBe('30m');
		expect(relativeAge('2026-01-10T09:00:00.000Z', now)).toBe('3h');
		expect(relativeAge('2026-01-07T12:00:00.000Z', now)).toBe('3d');
	});

	it('collapses the last minute into "now"', () => {
		expect(relativeAge('2026-01-10T11:59:40.000Z', now)).toBe('now');
	});

	it('hides unknown, invalid and stale dates', () => {
		expect(relativeAge(null, now)).toBe('');
		expect(relativeAge('not-a-date', now)).toBe('');
		expect(relativeAge('2024-01-01T00:00:00.000Z', now)).toBe('');
	});
});

describe('hrefs', () => {
	it('mirror the sidebar scopes', () => {
		expect(articleHref(7)).toBe('/?article=7');
		expect(feedHref(3)).toBe('/?filter=all&feed=3');
		expect(collectionHref(2)).toBe('/?filter=all&collection=2');
		expect(tagHref(9)).toBe('/?filter=all&tag=9');
		expect(smartViewHref(4)).toBe('/?view=4');
	});
});

describe('articlePaletteItems', () => {
	const now = Date.parse('2026-01-10T12:00:00.000Z');

	it('prefixes ids so groups never collide', () => {
		expect(articlePaletteItems([{ id: 5, title: 'Hello' }], now)[0].id).toBe('article-5');
	});

	it('builds a feed + age hint and drops empty parts', () => {
		const [withFeed, withoutFeed] = articlePaletteItems(
			[
				{ id: 1, title: 'A', feedTitle: 'Tech', publishedAt: '2026-01-10T09:00:00.000Z' },
				{ id: 2, title: 'B', feedTitle: null, publishedAt: null }
			],
			now
		);
		expect(withFeed.hint).toBe('Tech · 3h');
		expect(withoutFeed.hint).toBe('');
	});

	it('links to the article on the home route', () => {
		expect(articlePaletteItems([{ id: 42, title: 'Deep dive' }], now)[0].href).toBe('/?article=42');
	});
});
