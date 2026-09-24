// Shared tag helpers (pure, unit-testable, usable from Svelte components).
//
// Model: tags are per-user labels (`tag` table, unique per user+name).
// Articles link via `article_tag`. Feed `<category>` values auto-create tags
// on ingest; users can also add/remove tags manually.

export interface TagRow {
	id: number;
	name: string;
	/** How many of this user's articles carry the tag (optional in some views). */
	count?: number;
}

/**
 * A tag attached to an article. `id` powers the tag-filter links
 * (`/?filter=all&tag=<id>`), `name` is what the reader sees.
 */
export interface TagRef {
	id: number;
	name: string;
}

export function normalizeTagName(name: string): string {
	return name.trim().replace(/\s+/g, ' ').slice(0, 60);
}

/** Split a free-form input ("a, b c") into clean tag names. */
export function parseTagInput(input: string): string[] {
	const seen = new Set<string>();
	for (const part of input.split(',')) {
		const clean = normalizeTagName(part).toLowerCase();
		if (clean) seen.add(clean);
		if (seen.size >= 20) break;
	}
	return [...seen];
}

/** Feed `<category>` fragments that are never real tags (URLs, time chrome). */
const FEED_TAG_BLOCKLIST = new Set([
	'http',
	'https',
	'www',
	'html',
	'com',
	'cn',
	'page',
	'pages',
	'ago',
	'min',
	'mins',
	'hrs',
	'secs'
]);

/** Clean raw feed `<category>` values into tag names (max 10 per article). */
export function normalizeFeedTags(values: unknown): string[] {
	if (!Array.isArray(values)) return [];
	const seen = new Set<string>();
	for (const v of values) {
		const s =
			typeof v === 'string'
				? v
				: typeof v === 'object' && v !== null
					? String((v as Record<string, unknown>).name ?? (v as Record<string, unknown>).term ?? '')
					: '';
		const clean = normalizeTagName(s).toLowerCase();
		if (!clean) continue;
		if (clean.length < 2 || clean.length > 40) continue;
		if (FEED_TAG_BLOCKLIST.has(clean)) continue;
		if (/^\d+$/.test(clean)) continue;
		// URL-like values ("http://…", "www.…", "81rc.mil.cn") are chrome, not tags.
		if (/:\/\//.test(clean) || /^www\./.test(clean)) continue;
		if (/\.(com|cn|net|org|gov|edu|mil|io|html?|php|aspx|jsp)\b/.test(clean)) continue;
		if (/\b\d+\s*(secs?|mins?|hrs?|hours?|days?)\s+ago\b/.test(clean)) continue;
		seen.add(clean);
		if (seen.size >= 10) break;
	}
	return [...seen];
}

export function validateTagName(name: string): string | null {
	const clean = normalizeTagName(name);
	if (!clean) return 'Tag name is required.';
	if (clean.length > 60) return 'Tag name is too long.';
	return null;
}
