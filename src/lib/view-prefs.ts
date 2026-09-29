import type { ArticleView } from '$lib/article.js';

/** Input identifying which article list scope a view mode belongs to. */
export interface ViewScopeInput {
	filter?: string | null;
	feedId?: number | null;
	collectionId?: number | null;
	viewId?: number | null;
	tagId?: number | null;
	query?: string | null;
}

/** Scopes without an explicit saved mode fall back to these defaults. */
const MAGAZINE_DEFAULT_SCOPES = new Set(['filter:today', 'filter:saved', 'filter:recommended']);

/**
 * Stable per-scope key for view-mode prefs. Most-specific scope wins so
 * every collection / smart view / feed / tag remembers its own layout;
 * bare filters and search share a key each.
 */
export function getViewScopeKey(input: ViewScopeInput): string {
	if (input.viewId != null && Number.isFinite(input.viewId)) return `view:${input.viewId}`;
	if (input.collectionId != null && Number.isFinite(input.collectionId))
		return `collection:${input.collectionId}`;
	if (input.feedId != null && Number.isFinite(input.feedId)) return `feed:${input.feedId}`;
	if (input.tagId != null && Number.isFinite(input.tagId)) return `tag:${input.tagId}`;
	if (input.query?.trim()) return 'search';
	return `filter:${input.filter ?? 'today'}`;
}

/** Default layout for a scope: magazine for Today / Read later / Recommended, list otherwise. */
export function defaultViewForScope(scope: string): ArticleView {
	return MAGAZINE_DEFAULT_SCOPES.has(scope) ? 'magazine' : 'list';
}

/** Resolve the effective view for a scope from saved prefs + defaults. */
export function resolveView(
	prefs: Record<string, ArticleView>,
	scope: string,
	isArticleView: (value: unknown) => value is ArticleView
): ArticleView {
	const saved = prefs[scope];
	if (isArticleView(saved)) return saved;
	return defaultViewForScope(scope);
}
