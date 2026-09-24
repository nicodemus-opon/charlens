import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ArticleList from './article-list.svelte';
import type { ArticleRow } from '$lib/article.js';

const articles: ArticleRow[] = [
	{
		id: 1,
		feedId: 1,
		feedTitle: 'AD Blogs',
		title: 'Gardened roof planes float above the M house',
		link: 'https://example.com/1',
		author: null,
		publishedAt: new Date(),
		excerpt: 'A short excerpt for the flush list row.',
		imageUrl: null,
		isRead: false,
		isSaved: false,
		readMinutes: 5,
		tags: [{ id: 1, name: 'design' }]
	},
	{
		id: 2,
		feedId: 1,
		feedTitle: 'Discovery',
		title: 'Squirrels are not so bad after all',
		link: 'https://example.com/2',
		author: null,
		publishedAt: new Date(),
		excerpt: null,
		imageUrl: 'https://example.com/img.jpg',
		isRead: true,
		isSaved: true,
		readMinutes: 9,
		tags: []
	}
];

describe('article-list', () => {
	const href = (id: number) => `#article-${id}`;

	it('renders a flush list with dividers and reading time', async () => {
		render(ArticleList, { articles, view: 'list', href });

		const rows = page.getByRole('link');
		await expect.element(rows.first()).toBeInTheDocument();
		expect(await rows.all()).toHaveLength(2);

		await expect
			.element(page.getByText('Gardened roof planes float above the M house'))
			.toBeInTheDocument();
		await expect.element(page.getByText('5 min')).toBeInTheDocument();
		await expect.element(page.getByText('Saved')).toBeInTheDocument();
		// Tag chips carry the tag name (the id is only used for `?tag=` links).
		await expect.element(page.getByText('design')).toBeInTheDocument();
	});

	it('renders the card grid with image, feed and reading time', async () => {
		render(ArticleList, { articles, view: 'grid', href });

		await expect.element(page.getByText('9 min')).toBeInTheDocument();
		await expect.element(page.getByText('Discovery')).toBeInTheDocument();
		const card = page.getByRole('link', { name: /Squirrels are not so bad/ });
		await expect
			.element(card.getByRole('presentation'))
			.toHaveAttribute('src', 'https://example.com/img.jpg');
	});

	it('renders compact rows with a bookmark toggle, feed, inline excerpt and reading time', async () => {
		render(ArticleList, { articles, view: 'compact', href });

		const rows = page.getByRole('link');
		await expect.element(rows.first()).toBeInTheDocument();
		expect(await rows.all()).toHaveLength(2);

		await expect.element(page.getByText('AD Blogs')).toBeInTheDocument();
		await expect
			.element(page.getByText('Gardened roof planes float above the M house'))
			.toBeInTheDocument();
		await expect
			.element(page.getByText('A short excerpt for the flush list row.'))
			.toBeInTheDocument();
		await expect.element(page.getByText('5min')).toBeInTheDocument();
		await expect.element(page.getByText('9min')).toBeInTheDocument();
		// The feed column is content-sized (capped at 144px), never a rigid fixed
		// width, so the gap before the title collapses in narrow panes instead of
		// wasting space (regression: `w-36` always measured exactly 144px).
		const feed = [...document.querySelectorAll('span')].find(
			(s) => s.textContent?.trim() === 'AD Blogs'
		);
		const feedWidth = feed?.getBoundingClientRect().width ?? 0;
		expect(feedWidth).toBeGreaterThan(0);
		expect(feedWidth).toBeLessThan(144);
		await expect
			.element(page.getByRole('button', { name: 'Save for later' }).first())
			.toBeInTheDocument();
	});

	it('shows the empty state when there are no articles', async () => {
		render(ArticleList, { articles: [], view: 'list', href });

		await expect.element(page.getByText('No articles yet')).toBeInTheDocument();
	});
});
