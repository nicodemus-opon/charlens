// Shared helpers for the ⌘K command palette (pure, unit-testable, usable from
// Svelte components).
//
// The palette searches everything a reader navigates by — articles, tags,
// collections, smart views and feeds — plus a few fixed "go to" destinations.
// Ranking and URL building live here so the component stays presentation-only
// and the rules stay covered by tests.

/** One navigable row in the palette: a searchable label plus its target URL. */
export interface PaletteItem extends Matchable {
	id: string;
	href: string;
}

/** Anything the palette can rank: a label, optional metadata and extra keywords. */
export interface Matchable {
	label: string;
	hint?: string;
	keywords?: string[];
}

/** Article rows returned by `GET /api/articles/search`. */
export interface PaletteArticle {
	id: number;
	title: string;
	feedTitle?: string | null;
	publishedAt?: string | null;
	isRead?: boolean;
}

/** Collapse case/whitespace so " AI   News " and "ai news" match the same way. */
function normalize(value: string): string {
	return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Fuzzy fallback: every query character appears in order ("cmdk" → "command k"). */
function isSubsequence(needle: string, haystack: string): boolean {
	let cursor = 0;
	for (const char of haystack) {
		if (char === needle[cursor]) cursor += 1;
		if (cursor === needle.length) return true;
	}
	return false;
}

/**
 * Score one haystack against the query: 1 is an exact match, 0 is no match.
 * An empty query matches everything so an untouched palette can suggest items.
 */
export function scoreText(text: string, query: string): number {
	const needle = normalize(query);
	if (!needle) return 1;
	const haystack = normalize(text);
	if (!haystack) return 0;
	if (haystack === needle) return 1;
	if (haystack.startsWith(needle)) return 0.9;
	// Whole-word hits ("news" in "AI news daily") beat mid-word ones ("news" in "renews").
	if (haystack.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(needle))) return 0.75;
	if (haystack.includes(needle)) return 0.5;
	return isSubsequence(needle, haystack) ? 0.25 : 0;
}

/** Score an item by label, then keywords, then hint (label is what the reader sees). */
export function scoreItem(item: Matchable, query: string): number {
	const label = scoreText(item.label, query);
	const keyword = (item.keywords ?? []).reduce(
		(best, word) => Math.max(best, scoreText(word, query)),
		0
	);
	const hint = item.hint ? scoreText(item.hint, query) : 0;
	return Math.max(label, keyword * 0.8, hint * 0.6);
}

/** Whether a single item should be shown for this query. */
export function matchesQuery(item: Matchable, query: string): boolean {
	return scoreItem(item, query) > 0;
}

/**
 * Filter + rank a palette group: best matches first, original order kept for
 * ties, capped at `limit` so every group stays scannable.
 */
export function rankPaletteItems<T extends Matchable>(
	items: readonly T[],
	query: string,
	limit = 6
): T[] {
	return items
		.map((item, index) => ({ item, index, score: scoreItem(item, query) }))
		.filter((scored) => scored.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, limit)
		.map((scored) => scored.item);
}

/**
 * Compact age for article hints ("3h", "2d"). Returns '' for unknown dates and
 * for anything older than a month, where the row's feed name says more.
 */
export function relativeAge(value: string | Date | null | undefined, now = Date.now()): string {
	if (!value) return '';
	const time = value instanceof Date ? value.getTime() : Date.parse(value);
	if (!Number.isFinite(time)) return '';
	const minutes = Math.floor(Math.max(0, now - time) / 60000);
	if (minutes < 1) return 'now';
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return days <= 30 ? `${days}d` : '';
}

// Navigation targets mirror the sidebar's links (see app-sidebar `href`): a
// scope always replaces the current feed/collection/view scope.
export function articleHref(id: number): string {
	return `/?article=${id}`;
}

export function feedHref(id: number): string {
	return `/?filter=all&feed=${id}`;
}

export function collectionHref(id: number): string {
	return `/?filter=all&collection=${id}`;
}

export function tagHref(id: number): string {
	return `/?filter=all&tag=${id}`;
}

export function smartViewHref(id: number): string {
	return `/?view=${id}`;
}

/** Map search API rows to palette rows (feed name + age as the hint). */
export function articlePaletteItems(
	articles: readonly PaletteArticle[],
	now = Date.now()
): PaletteItem[] {
	return articles.map((article) => ({
		id: `article-${article.id}`,
		label: article.title,
		hint: [article.feedTitle, relativeAge(article.publishedAt, now)].filter(Boolean).join(' · '),
		href: articleHref(article.id)
	}));
}
