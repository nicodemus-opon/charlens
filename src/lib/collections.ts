// Shared collection / smart-view types and pure helpers (no DB imports,
// so they are unit-testable and usable from Svelte components).
//
// Model: a Collection groups feeds (one feed → one collection, like
// FreshRSS/Miniflux). `kind` distinguishes manual collections from smart
// views, which hold no feeds and instead resolve `rules` at read time
// (RSSMonster Smart Folders / FreshRSS user queries style).

export const GENERAL_COLLECTION = 'General';

export type CollectionKind = 'manual' | 'smart';

export interface SmartRules {
	/** How multiple predicates combine. Defaults to 'all'. */
	match?: 'all' | 'any';
	/** Keywords matched (case-insensitive) against title/excerpt/author. */
	keywords?: string[];
	/** Substring matched against the article author. */
	author?: string;
	/** Restrict to these feed ids (ownership is still enforced server-side). */
	feedIds?: number[];
	/** Only articles carrying ALL of these tag names (lowercase). */
	tags?: string[];
	/** Only unread articles. */
	unreadOnly?: boolean;
	/** Only saved articles. */
	savedOnly?: boolean;
	/** Only articles published in the last N days. */
	daysBack?: number;
}

export interface CollectionRow {
	id: number;
	name: string;
	kind: CollectionKind;
	rules: SmartRules | null;
	position: number;
	feedCount: number;
	unread: number;
}

export function normalizeCollectionName(name: string): string {
	return name.trim().slice(0, 60);
}

/** A smart view needs at least one predicate to be useful. */
export function validateSmartRules(rules: SmartRules): string | null {
	const keywords = (rules.keywords ?? []).map((k) => k.trim()).filter(Boolean);
	const author = (rules.author ?? '').trim();
	const feedIds = (rules.feedIds ?? []).filter((n) => Number.isFinite(n));
	const tags = (rules.tags ?? []).map((t) => t.trim()).filter(Boolean);
	if (
		keywords.length === 0 &&
		!author &&
		feedIds.length === 0 &&
		tags.length === 0 &&
		!rules.unreadOnly &&
		!rules.savedOnly &&
		!(rules.daysBack && rules.daysBack > 0)
	) {
		return 'Add at least one rule (keyword, author, feed, tag, unread/saved, or age).';
	}
	return null;
}

export function normalizeSmartRules(input: SmartRules): SmartRules {
	const keywords = [...new Set((input.keywords ?? []).map((k) => k.trim()).filter(Boolean))].slice(
		0,
		20
	);
	const author = (input.author ?? '').trim().slice(0, 120) || undefined;
	const feedIds = [
		...new Set((input.feedIds ?? []).filter((n) => Number.isInteger(n) && n > 0))
	].slice(0, 100);
	const tags = [
		...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))
	].slice(0, 20);
	const daysBack =
		input.daysBack && Number.isFinite(input.daysBack)
			? Math.min(3650, Math.max(1, Math.floor(input.daysBack)))
			: undefined;
	return {
		match: input.match === 'any' ? 'any' : 'all',
		...(keywords.length ? { keywords } : {}),
		...(author ? { author } : {}),
		...(feedIds.length ? { feedIds } : {}),
		...(tags.length ? { tags } : {}),
		...(input.unreadOnly ? { unreadOnly: true } : {}),
		...(input.savedOnly ? { savedOnly: true } : {}),
		...(daysBack ? { daysBack } : {})
	};
}

/** Parse + normalize untrusted JSON (form posts, DB rows) into SmartRules. */
export function parseSmartRules(value: unknown): SmartRules | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const v = value as Record<string, unknown>;
	const keywords = Array.isArray(v.keywords)
		? v.keywords.filter((k): k is string => typeof k === 'string')
		: typeof v.keywords === 'string'
			? v.keywords.split(',')
			: [];
	const feedIds = Array.isArray(v.feedIds ?? v.feed_ids)
		? ((v.feedIds ?? v.feed_ids) as unknown[])
				.map(Number)
				.filter((n) => Number.isInteger(n) && n > 0)
		: typeof v.feedIds === 'string'
			? v.feedIds
					.split(',')
					.map(Number)
					.filter((n) => Number.isInteger(n) && n > 0)
			: [];
	const daysBack =
		typeof v.daysBack === 'number'
			? v.daysBack
			: typeof v.days_back === 'number'
				? (v.days_back as number)
				: typeof v.daysBack === 'string' && v.daysBack.trim()
					? Number(v.daysBack)
					: undefined;
	const tags = Array.isArray(v.tags)
		? v.tags.filter((t): t is string => typeof t === 'string')
		: typeof v.tags === 'string'
			? v.tags.split(',')
			: [];
	return normalizeSmartRules({
		match: v.match === 'any' ? 'any' : 'all',
		keywords,
		author: typeof v.author === 'string' ? v.author : undefined,
		feedIds,
		tags,
		unreadOnly: v.unreadOnly === true || v.unread_only === true,
		savedOnly: v.savedOnly === true || v.saved_only === true,
		daysBack: daysBack && Number.isFinite(daysBack) ? daysBack : undefined
	});
}
