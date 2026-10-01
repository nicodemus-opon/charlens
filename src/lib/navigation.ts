// Single source for feed-scope navigation: which top-level filter is active,
// whether the list is scoped to a feed/collection/view/tag, and building
// hrefs that move between scopes. The sidebar keeps its own `href` (it
// preserves `tag` when explicitly passed) — everything else uses these.
export type ScopeState = {
	/** Active top-level filter (`today` when the param is missing). */
	filter: string;
	/** True when the list is scoped to a feed, collection, smart view or tag. */
	hasScope: boolean;
};

export function getScopeState(params: URLSearchParams): ScopeState {
	return {
		filter: params.get('filter') ?? 'today',
		hasScope:
			params.has('feed') || params.has('collection') || params.has('view') || params.has('tag')
	};
}

/**
 * Href that moves to a single scope: applies the overrides, drops any tag
 * filter (a new scope is unambiguous) and clears the open article so the
 * list shows on its own. Search text (`q`) and recommendation shuffle state
 * (`shuffle`/`deep`) never carry over — a stale `q` would silently flip
 * Today/Saved into the heavy semantic-ranking path, and a stale `shuffle`
 * is meaningless outside Recommended. Pass `null` to remove a param.
 */
export function buildScopeHref(current: URL, params: Record<string, string | null>): string {
	const url = new URL(current);
	if (!('tag' in params)) url.searchParams.delete('tag');
	if (!('q' in params)) url.searchParams.delete('q');
	if (!('shuffle' in params)) url.searchParams.delete('shuffle');
	if (!('deep' in params)) url.searchParams.delete('deep');
	for (const [k, v] of Object.entries(params)) {
		if (v === null) url.searchParams.delete(k);
		else url.searchParams.set(k, v);
	}
	url.searchParams.delete('article');
	// Feed scopes live on `/` — never preserve the current pathname, otherwise
	// clicking Today/All/etc from `/settings` lands on `/settings?filter=…`
	// and the view never changes.
	return `/?${url.searchParams.toString()}`;
}
