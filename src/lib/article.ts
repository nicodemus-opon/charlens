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

/** How the article list is rendered. `compact` is the dense, one-line table-style view. */
export type ArticleView = 'list' | 'grid' | 'compact';

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
