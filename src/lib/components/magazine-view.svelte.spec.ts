import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import MagazineView from './magazine-view.svelte';
import type { ArticleRow } from '$lib/article.js';

const ai = { id: 1, name: 'ai' };
const climate = { id: 2, name: 'climate' };

function row(partial: Partial<ArticleRow> & { id: number }): ArticleRow {
	return {
		feedId: 1,
		feedTitle: 'Feed',
		title: `Story ${partial.id}`,
		link: `https://example.com/${partial.id}`,
		author: 'Jane Doe',
		publishedAt: new Date(),
		excerpt: 'A short excerpt for the front page.',
		imageUrl: null,
		isRead: true,
		isSaved: false,
		readMinutes: 5,
		tags: [],
		...partial
	};
}

const articles: ArticleRow[] = [
	row({ id: 1, isRead: false, imageUrl: 'https://example.com/1.jpg' }),
	row({ id: 2 }),
	row({ id: 3 }),
	row({ id: 4, tags: [ai] }),
	row({ id: 5, tags: [ai] }),
	row({ id: 6, tags: [climate] }),
	row({ id: 7, tags: [climate] }),
	row({ id: 8 })
];

describe('magazine-view', () => {
	const href = (id: number) => `#article-${id}`;
	const tagHref = (tagId: number) => `#tag-${tagId}`;

	it('renders the masthead, hero lead and topic desks', async () => {
		render(MagazineView, { articles, title: 'Today', href, tagHref });

		// Masthead edition scope.
		await expect.element(page.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
		await expect.element(page.getByText(/8 stories · .* unread · 2 topics/)).toBeInTheDocument();

		// Hero lead + secondary stories.
		await expect.element(page.getByText('Story 1')).toBeInTheDocument();
		await expect.element(page.getByText('Story 2')).toBeInTheDocument();

		// Journalist desks with tag navigation.
		await expect.element(page.getByRole('heading', { name: 'ai' })).toBeInTheDocument();
		await expect.element(page.getByRole('heading', { name: 'climate' })).toBeInTheDocument();
		await expect.element(page.getByRole('link', { name: 'View all' }).first()).toBeInTheDocument();

		// Desk leftovers land in Latest.
		await expect.element(page.getByText('Latest')).toBeInTheDocument();
	});

	it('shows the empty state when there are no articles', async () => {
		render(MagazineView, { articles: [], href, tagHref });

		await expect.element(page.getByText('No articles yet')).toBeInTheDocument();
	});
});
