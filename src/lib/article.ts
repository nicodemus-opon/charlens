import type { TagRef } from '$lib/tags';

/** Shape of an article row as returned by `getArticles` (see $lib/server/rss/refresh). */
export interface ArticleRow {
	id: number;
	feedId: number;
	feedTitle: string;
	title: string;
	link: string;
	author: string | null;
	publishedAt: Date | null;
	excerpt: string | null;
	imageUrl: string | null;
	isRead: boolean;
	isSaved: boolean;
	/** Estimated reading time in minutes, computed from the article body. */
	readMinutes: number | null;
	/** Tags attached to the article (ids power the tag-filter links). */
	tags: TagRef[];
}

/** How the article list is rendered. `compact` is the dense, one-line table-style view, `magazine` is the news front-page view. */
export type ArticleView = 'list' | 'grid' | 'compact' | 'magazine';

/** Client-side article ordering offered by the sort dropdown. */
export type ArticleSort = 'newest' | 'oldest' | 'title';

function sortTime(value: ArticleRow['publishedAt']): number {
	if (!value) return 0;
	return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Sorts articles for display without mutating the input (unit-tested). */
export function sortArticles<T extends ArticleRow>(articles: T[], sort: ArticleSort): T[] {
	const copy = [...articles];
	if (sort === 'oldest') {
		copy.sort((a, b) => sortTime(a.publishedAt) - sortTime(b.publishedAt));
	} else if (sort === 'title') {
		copy.sort((a, b) => a.title.localeCompare(b.title));
	} else {
		copy.sort((a, b) => sortTime(b.publishedAt) - sortTime(a.publishedAt));
	}
	return copy;
}

/**
 * Focus-mode decision helper (unit-tested).
 *
 * Focus (reader-only, list hidden) applies when the user enabled focus mode,
 * an article is explicitly in view (`?article=` present) and it resolved.
 * The list is shown on its own only when no article is in view.
 */
export function shouldShowFocus(options: {
	focusMode: boolean;
	hasArticleParam: boolean;
	hasSelected: boolean;
}): boolean {
	return options.focusMode && options.hasArticleParam && options.hasSelected;
}
