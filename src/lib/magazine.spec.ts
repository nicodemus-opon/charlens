import { describe, expect, it } from 'vitest';
import { buildMagazineSections, buildTopicDesks } from './magazine';
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
			desks: [],
			latest: [],
			rest: []
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
			...sections.desks.flatMap((d) => d.articles.map((a) => a.id)),
			...sections.latest.map((a) => a.id),
			...sections.rest.map((a) => a.id)
		];
		expect(new Set(ids).size).toBe(articles.length);
	});
});

describe('buildTopicDesks', () => {
	it('returns no desks when no topic repeats', () => {
		const articles = [row({ id: 1, tags: [ai] }), row({ id: 2, tags: [climate] })];
		expect(buildTopicDesks(articles)).toEqual([]);
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
		expect(desks[0].articles.map((a) => a.id)).toEqual([1, 2, 3]);
		expect(desks[1].articles.map((a) => a.id)).toEqual([6, 7]);
	});

	it('caps desks at three stories by default, spilling the rest into latest', () => {
		const articles = [
			row({ id: 1, isRead: false, imageUrl: 'https://example.com/1.jpg' }),
			row({ id: 2 }),
			row({ id: 3 }),
			row({ id: 4, tags: [ai] }),
			row({ id: 5, tags: [ai] }),
			row({ id: 6, tags: [ai] }),
			row({ id: 7, tags: [ai] }),
			row({ id: 8, tags: [ai] })
		];
		const sections = buildMagazineSections(articles);
		expect(sections.desks).toHaveLength(1);
		expect(sections.desks[0].articles.map((a) => a.id)).toEqual([4, 5, 6]);
		expect(sections.latest.map((a) => a.id)).toEqual([7, 8]);
	});
});
