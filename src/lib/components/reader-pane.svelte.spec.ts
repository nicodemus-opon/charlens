import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ReaderPane, { type FullArticle } from './reader-pane.svelte';

const article: FullArticle = {
	id: 7,
	feedTitle: 'AD Blogs',
	title: 'Gardened roof planes float above the M house',
	link: 'https://example.com/7',
	author: null,
	publishedAt: new Date(),
	excerpt: 'A short excerpt for the reader.',
	contentHtml: '<p>Body copy long enough to render as the article.</p>',
	imageUrl: null,
	isRead: true,
	isSaved: false,
	tags: [
		{ id: 3, name: 'design' },
		{ id: 4, name: 'ai' }
	]
};

describe('reader-pane tags', () => {
	it('links each tag to the article list filtered by that tag', async () => {
		const onTagClick = vi.fn();
		render(ReaderPane, {
			article,
			tagHref: (id) => `/?filter=all&tag=${id}`,
			onTagClick
		});

		const design = page.getByRole('link', { name: 'design' });
		await expect.element(design).toHaveAttribute('href', '/?filter=all&tag=3');
		await expect
			.element(page.getByRole('link', { name: 'ai' }))
			.toHaveAttribute('href', '/?filter=all&tag=4');

		// Activating the chip lets the page reveal the (collapsed) article list.
		await design.click();
		expect(onTagClick).toHaveBeenCalledOnce();
	});

	it('renders plain badges when no tag link builder is provided', async () => {
		render(ReaderPane, { article });

		await expect.element(page.getByText('design')).toBeInTheDocument();
		expect(await page.getByRole('link', { name: 'design' }).all()).toHaveLength(0);
	});
});
