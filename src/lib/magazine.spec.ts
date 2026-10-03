import { describe, expect, it } from 'vitest';
import {
	layOutRows,
	buildBlocks,
	buildMagazineSections,
	buildTopicDesks,
	getStoryEmphasis,
	pickDeskPattern,
	pickHeroVariant
} from './magazine';
import type { ArticleRow } from './article';

function row(partial: Partial<ArticleRow> & { id: number }): ArticleRow {
	return {
		feedId: 1,
		feedTitle: 'Feed',
		title: `Story ${partial.id}`,
		link: `https://example.com/${partial.id}`,
		author: null,
		publishedAt: new Date(),
		excerpt: null,
		imageUrl: null,
		isRead: true,
		isSaved: false,
		readMinutes: null,
		tags: [],
		...partial
	};
}

const ai = { id: 1, name: 'ai' };
const climate = { id: 2, name: 'climate' };

describe('buildMagazineSections', () => {
	it('returns empty sections for no articles', () => {
		expect(buildMagazineSections([])).toEqual({
			lead: null,
			secondary: [],
			hero: 'cover',
			latest: [],
			desks: [],
			rest: [],
			blocks: []
		});
	});

	it('prefers an unread story with an image as the lead', () => {
		const articles = [
			row({ id: 1, isRead: false }),
			row({ id: 2, isRead: false, imageUrl: 'https://example.com/img.jpg' }),
			row({ id: 3, isRead: false })
		];
		const sections = buildMagazineSections(articles);
		expect(sections.lead?.id).toBe(2);
		expect(sections.secondary.map((a) => a.id)).toEqual([1, 3]);
	});

	it('falls back to the first unread, then the first article', () => {
		expect(buildMagazineSections([row({ id: 1 }), row({ id: 2 })]).lead?.id).toBe(1);
		const withUnread = [row({ id: 1 }), row({ id: 2, isRead: false })];
		expect(buildMagazineSections(withUnread).lead?.id).toBe(2);
	});

	it('files desk stories out of latest without overlap or duplicates', () => {
		const articles = [
			row({ id: 1, isRead: false, imageUrl: 'https://example.com/1.jpg' }),
			row({ id: 2 }),
			row({ id: 3 }),
			row({ id: 4, tags: [ai] }),
			row({ id: 5, tags: [ai] }),
			row({ id: 6, tags: [ai, climate] }),
			row({ id: 7, tags: [climate] }),
			row({ id: 8, tags: [climate] }),
			row({ id: 9 })
		];
		const sections = buildMagazineSections(articles);
		expect(sections.lead?.id).toBe(1);
		expect(sections.secondary.map((a) => a.id)).toEqual([2, 3]);
		expect(sections.desks.map((d) => d.tag.name)).toEqual(['ai', 'climate']);
		// Story 6 carries both topics and is filed under its first-ranked desk only.
		expect(sections.desks[0].articles.map((a) => a.id)).toEqual([4, 5, 6]);
		expect(sections.desks[1].articles.map((a) => a.id)).toEqual([7, 8]);
		expect(sections.latest.map((a) => a.id)).toEqual([9]);
		expect(sections.rest).toEqual([]);
		const ids = [
			sections.lead!.id,
			...sections.secondary.map((a) => a.id),
			...sections.latest.map((a) => a.id),
			...sections.desks.flatMap((d) => d.articles.map((a) => a.id)),
			...sections.rest.map((a) => a.id)
		];
		expect(new Set(ids).size).toBe(articles.length);
	});
});

describe('buildTopicDesks', () => {
	it('needs two stories to earn a desk - singletons fall to Latest', () => {
		const articles = [row({ id: 1, tags: [ai] }), row({ id: 2, tags: [climate] })];
		expect(buildTopicDesks(articles)).toEqual([]);
	});

	it('drops desks starved by a higher-ranked desk (no one-card desks)', () => {
		// 'classroom' outranks 'interactive', so the shared story files to
		// classroom and interactive would be left with a single story - the
		// giant one-card desk. Starved desks must fall through instead.
		const classroom = { id: 10, name: 'classroom' };
		const interactive = { id: 11, name: 'interactive' };
		const articles = [
			row({ id: 1, tags: [classroom, interactive] }),
			row({ id: 2, tags: [classroom] }),
			row({ id: 3, tags: [interactive] })
		];
		const desks = buildTopicDesks(articles);
		expect(desks.map((d) => d.tag.name)).toEqual(['classroom']);
		for (const d of desks) expect(d.articles.length).toBeGreaterThanOrEqual(2);
		// The starved topic's story is not lost - it lands in Latest.
		const sections = buildMagazineSections(articles);
		const placed = [
			sections.lead?.id,
			...sections.secondary.map((a) => a.id),
			...sections.latest.map((a) => a.id),
			...sections.desks.flatMap((d) => d.articles.map((a) => a.id)),
			...sections.rest.map((a) => a.id)
		].sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(placed).toEqual([1, 2, 3]);
	});

	it('returns no desks when nothing is tagged', () => {
		expect(buildTopicDesks([row({ id: 1 }), row({ id: 2 })])).toEqual([]);
	});

	it('ranks desks by story count and caps desks and stories', () => {
		const articles = [
			row({ id: 1, tags: [ai] }),
			row({ id: 2, tags: [ai] }),
			row({ id: 3, tags: [ai] }),
			row({ id: 4, tags: [ai] }),
			row({ id: 5, tags: [ai] }),
			row({ id: 6, tags: [climate] }),
			row({ id: 7, tags: [climate] })
		];
		const desks = buildTopicDesks(articles, { maxDesks: 2, maxStories: 3 });
		expect(desks.map((d) => d.tag.name)).toEqual(['ai', 'climate']);
		expect(desks[0].articles.map((a) => a.id)).toEqual([1, 2, 3, 4, 5]);
		// Explicit maxStories sizes the grid; overflow stays on the desk tail.
		expect(desks[0].rows.flatMap((r) => r.stories).map((st) => st.article.id)).toEqual([1, 2, 3]);
		expect(desks[0].more.map((a) => a.id)).toEqual([4, 5]);
		expect(desks[1].articles.map((a) => a.id)).toEqual([6, 7]);
	});

	it('caps the desk at a 4-card grid plus a 5-row headline list', () => {
		const articles = [
			row({ id: 1, isRead: false, imageUrl: 'https://example.com/1.jpg' }),
			row({ id: 2 }),
			row({ id: 3 }),
			...Array.from({ length: 10 }, (_, i) => row({ id: 4 + i, tags: [ai] }))
		];
		const sections = buildMagazineSections(articles);
		expect(sections.desks).toHaveLength(1);
		const desk = sections.desks[0];
		// Grid: first 4 stories. Headline list: capped at 5 rows.
		expect(desk.rows.flatMap((r) => r.stories).map((st) => st.article.id)).toEqual([4, 5, 6, 7]);
		expect(desk.more.map((a) => a.id)).toEqual([8, 9, 10, 11, 12]);
		// Overflow past the desk's list falls through to Latest, not lost.
		expect(desk.articles).toHaveLength(9);
		expect(sections.latest.map((a) => a.id)).toEqual([13]);
		// Every grid row still sums to 12 - edges align.
		for (const r of desk.rows) {
			expect(r.stories.reduce((n, st) => n + st.span, 0)).toBe(12);
		}
		expect(sections.rest).toEqual([]);
	});

	it('caps latest and more headlines so the page tail stays short', () => {
		const articles = [
			row({ id: 1, isRead: false, imageUrl: 'https://example.com/1.jpg' }),
			row({ id: 2 }),
			row({ id: 3 }),
			...Array.from({ length: 15 }, (_, i) => row({ id: 4 + i }))
		];
		const sections = buildMagazineSections(articles);
		expect(sections.desks).toEqual([]);
		expect(sections.latest).toHaveLength(6);
		expect(sections.rest).toHaveLength(5);
		expect(sections.latest.map((a) => a.id)).toEqual([4, 5, 6, 7, 8, 9]);
		expect(sections.rest.map((a) => a.id)).toEqual([10, 11, 12, 13, 14]);
	});
});

describe('smart nested dynamics', () => {
	it('scores emphasis from content signals, never random', () => {
		expect(getStoryEmphasis(row({ id: 1, imageUrl: 'https://example.com/a.jpg' }))).toBe('visual');
		expect(getStoryEmphasis(row({ id: 2, isRead: false, isSaved: true }))).toBe('featured');
		expect(getStoryEmphasis(row({ id: 3, isRead: false, readMinutes: 9, excerpt: 'x' }))).toBe(
			'featured'
		);
		expect(getStoryEmphasis(row({ id: 4, isRead: true, readMinutes: 1 }))).toBe('brief');
		expect(getStoryEmphasis(row({ id: 5, isRead: true, readMinutes: 5, excerpt: 'x' }))).toBe(
			'standard'
		);
	});

	it('picks a text-led pattern when a desk has no imagery', () => {
		const arts = [row({ id: 1, tags: [ai] }), row({ id: 2, tags: [ai] })];
		expect(pickDeskPattern(arts).pattern).toBe('headlines');
	});

	it('spotlights one clearly stronger visual story, symmetric when even', () => {
		const strong = [
			row({ id: 1, isRead: false, imageUrl: 'https://example.com/a.jpg', excerpt: 'x' }),
			row({ id: 2 }),
			row({ id: 3 })
		];
		const spot = pickDeskPattern(strong);
		expect(spot).toEqual({ pattern: 'spotlight', spotlightId: 1 });
		const even = [
			row({ id: 1, isRead: false, imageUrl: 'https://example.com/a.jpg' }),
			row({ id: 2, isRead: false, imageUrl: 'https://example.com/b.jpg' }),
			row({ id: 3, isRead: false, imageUrl: 'https://example.com/c.jpg' })
		];
		expect(pickDeskPattern(even).pattern).toBe('symmetric');
	});

	it('keeps ONE latest bento grid and puts dynamism inside via spans', () => {
		const articles = [
			row({ id: 1, isRead: false, imageUrl: 'https://example.com/1.jpg' }),
			row({ id: 2 }),
			row({ id: 3 }),
			row({ id: 4, tags: [ai] }),
			row({ id: 5, tags: [ai] }),
			row({ id: 6, tags: [ai, climate] }),
			row({ id: 7, tags: [climate] }),
			row({ id: 8, tags: [climate] }),
			row({ id: 9 })
		];
		const sections = buildMagazineSections(articles);
		const latestBlocks = sections.blocks.filter((b) => b.kind === 'latest');
		// Exactly one Latest header on the page.
		expect(latestBlocks).toHaveLength(1);
		const kinds = sections.blocks.map((b) => b.kind);
		expect(kinds[0]).toBe('latest');
		expect(kinds.filter((k) => k === 'desk')).toHaveLength(2);
		// Every story placed exactly once across latest + desks.
		const flat = sections.blocks.flatMap((b) =>
			b.kind === 'latest'
				? b.rows.flatMap((r) => r.stories.map((st) => st.article))
				: b.desk.articles
		);
		expect(flat.map((a) => a.id).sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8, 9]);
		// Deterministic: same input, same blocks.
		expect(buildBlocks(sections.desks, sections.latest)).toEqual(sections.blocks);
	});

	it('lays bento rows: strong visual leads earn 8+4 or 6+3+3, even pairs stay 6+6', () => {
		// Strong visual over a plain text companion earns the 8+4 feature row.
		const pair = [row({ id: 1, imageUrl: 'https://example.com/a.jpg' }), row({ id: 2 })];
		expect(layOutRows(pair).map((r) => r.stories.map((st) => st.span))).toEqual([[8, 4]]);

		// Even text pairs stay level at 6+6.
		const evenPair = [row({ id: 1, excerpt: 'x' }), row({ id: 2, excerpt: 'y' })];
		expect(layOutRows(evenPair).map((r) => r.stories.map((st) => st.span))).toEqual([[6, 6]]);

		// Visual leading two briefs flows into a 6+3+3 bento row.
		const arts = [
			row({ id: 1, imageUrl: 'https://example.com/a.jpg' }),
			row({ id: 2 }),
			row({ id: 3 }),
			row({ id: 4 })
		];
		const rows = layOutRows(arts);
		// Every row sums to exactly 12 - edges always align.
		for (const r of rows) {
			expect(r.stories.reduce((n, st) => n + st.span, 0)).toBe(12);
		}
		expect(rows.map((r) => r.stories.map((st) => st.span))).toEqual([[6, 3, 3], [12]]);
		// Same input, same rows - deterministic, not random.
		expect(layOutRows(arts)).toEqual(rows);
	});

	it('picks the hero shape from image signals only', () => {
		const visual = (id: number) => row({ id, imageUrl: `https://example.com/${id}.jpg` });
		expect(pickHeroVariant(visual(1), [visual(2), visual(3)])).toBe('trio');
		expect(pickHeroVariant(visual(1), [visual(2), row({ id: 3 })])).toBe('split');
		expect(pickHeroVariant(visual(1), [row({ id: 2 }), row({ id: 3 })])).toBe('cover');
		expect(pickHeroVariant(row({ id: 1 }), [row({ id: 2 }), row({ id: 3 })])).toBe('cover');
	});

	it('staggers even desks by offset so neighbours open differently', () => {
		const arts = [
			row({ id: 1, excerpt: 'a', imageUrl: 'https://example.com/a.jpg' }),
			row({ id: 2, excerpt: 'b' }),
			row({ id: 3, excerpt: 'c' }),
			row({ id: 4, excerpt: 'd' })
		];
		const first = layOutRows(arts, { offset: 0 }).map((r) => r.stories.map((st) => st.span));
		const second = layOutRows(arts, { offset: 1 }).map((r) => r.stories.map((st) => st.span));
		for (const rows of [first, second]) {
			for (const spans of rows) {
				expect(spans.reduce((n, s) => n + s, 0)).toBe(12);
			}
		}
		// Deterministic per offset.
		expect(layOutRows(arts, { offset: 0 }).map((r) => r.stories.map((st) => st.span))).toEqual(
			first
		);
	});
});
