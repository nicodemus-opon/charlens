import { env } from '$env/dynamic/private';

export interface PublisherSite {
	/** Publisher display name from the news source tag. */
	name: string;
	/** Site root (origin) the publisher's stories came from. */
	siteUrl: string;
}

const SEARCH_CACHE_MS = 60 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 12_000;
const MAX_CACHE_ENTRIES = 50;

/** Placeholder source names some publishers tag stories with. */
const GENERIC_SOURCE_NAMES = new Set([
	'article',
	'articles',
	'blog',
	'blogs',
	'post',
	'posts',
	'news',
	'home',
	'homepage'
]);

const searchCache = new Map<string, { at: number; sites: PublisherSite[] }>();

export function isFeedSearchEnabled(): boolean {
	return (env.FEED_SEARCH_ENABLED ?? '1') !== '0';
}

function searchTimeoutMs(): number {
	const n = Number(env.FEED_SEARCH_TIMEOUT_MS ?? SEARCH_TIMEOUT_MS);
	return Number.isFinite(n) && n > 0 ? Math.min(n, 30_000) : SEARCH_TIMEOUT_MS;
}

/**
 * Derive Google News locale from an Accept-Language header
 * (`en-KE,en;q=0.9` → `{ lang: 'en', region: 'KE' }`). Falls back to
 * en-US. Pure (tests).
 */
export function parseLocale(header: string | null): { lang: string; region: string } {
	const fallback = { lang: 'en', region: 'US' };
	if (!header) return fallback;
	const first = header.split(',')[0]?.trim().split(';')[0]?.trim();
	if (!first) return fallback;
	const parts = first.split('-');
	const lang = parts[0]?.toLowerCase() ?? '';
	if (!/^[a-z]{2,3}$/.test(lang)) return fallback;
	const regionRaw = parts[1]?.toUpperCase() ?? '';
	const region = /^[A-Z]{2}$/.test(regionRaw) ? regionRaw : 'US';
	return { lang: lang.slice(0, 2), region };
}

/** Normalize any URL to its https origin (`https://host`). Null when invalid. */
export function siteRoot(raw: string): string | null {
	try {
		const u = new URL(raw.trim());
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
		return `https://${u.hostname.toLowerCase()}`;
	} catch {
		return null;
	}
}

/** Platform hosts that are never directly followable feeds. */
const PLATFORM_HOSTS = new Set([
	'facebook.com',
	'linkedin.com',
	'instagram.com',
	'tiktok.com',
	'x.com',
	'twitter.com',
	'youtube.com'
]);

/**
 * Extract `<source url="...">Name</source>` publisher pairs from a Google
 * News RSS payload. Pure (tests) — network lives in `searchPublishers`.
 */
export function parseNewsSources(xml: string): PublisherSite[] {
	const out: PublisherSite[] = [];
	const seen = new Set<string>();
	const re = /<source\s+url="([^"]+)">([^<]{1,200})<\/source>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null) {
		const root = siteRoot(m[1]);
		const name = m[2].trim();
		if (!root || name.length < 3 || seen.has(root)) continue;
		// Some publishers tag stories with placeholder source names.
		if (GENERIC_SOURCE_NAMES.has(name.toLowerCase())) continue;
		let host = '';
		try {
			host = new URL(root).hostname.toLowerCase().replace(/^www\./, '');
		} catch {
			continue;
		}
		if (PLATFORM_HOSTS.has(host)) continue;
		seen.add(root);
		out.push({ name, siteUrl: root });
	}
	return out;
}

/**
 * Keyword → publisher sites currently writing about it, via the keyless
 * Google News RSS search. Returns site roots (feed discovery/verification
 * happens lazily in Preview/Follow). Cached 1h per query. Never throws.
 */
export async function searchPublishers(
	query: string,
	opts: { limit?: number; lang?: string; region?: string } = {}
): Promise<{ sites: PublisherSite[]; failed: boolean }> {
	const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
	const lang = /^[a-z]{2}$/.test(opts.lang ?? '') ? (opts.lang as string) : 'en';
	const region = /^[A-Z]{2}$/.test(opts.region ?? '') ? (opts.region as string) : 'US';
	const q = query.trim().slice(0, 200);
	if (q.length < 2 || !isFeedSearchEnabled()) return { sites: [], failed: false };
	const key = `${lang}:${region}:${q.toLowerCase()}`;
	const now = Date.now();
	const cached = searchCache.get(key);
	if (cached && now - cached.at < SEARCH_CACHE_MS) {
		return { sites: cached.sites.slice(0, limit), failed: false };
	}
	try {
		const url =
			`https://news.google.com/rss/search?q=${encodeURIComponent(q)}` +
			`&hl=${lang}&gl=${region}&ceid=${region}:${lang}`;
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), searchTimeoutMs());
		try {
			const res = await fetch(url, {
				signal: ctrl.signal,
				headers: {
					'User-Agent':
						'Mozilla/5.0 (compatible; charlens-rss/0.1; +https://github.com/nicodemus-opon/charlens)',
					Accept: 'application/rss+xml, application/xml, */*'
				}
			});
			if (!res.ok) return { sites: cached?.sites.slice(0, limit) ?? [], failed: true };
			const xml = await res.text();
			const sites = parseNewsSources(xml);
			searchCache.set(key, { at: now, sites });
			if (searchCache.size > MAX_CACHE_ENTRIES) {
				const oldest = searchCache.keys().next().value;
				if (oldest !== undefined) searchCache.delete(oldest);
			}
			return { sites: sites.slice(0, limit), failed: false };
		} finally {
			clearTimeout(t);
		}
	} catch (e) {
		console.error('publisher search failed', e);
		return { sites: cached?.sites.slice(0, limit) ?? [], failed: true };
	}
}

/** Test-only: reset the publisher search cache. */
export function _resetFeedSearchCache() {
	searchCache.clear();
}
