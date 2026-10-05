import Parser from 'rss-parser';
import { normalizeFeedTags } from '$lib/tags';
import { fetchExternal, IPV4_COMPAT_REQUEST_OPTIONS } from '$lib/server/net';
import { excerptFrom, pickImage, sanitizeArticleHtml, stripDuplicateImage } from './sanitize';
import { getRadarCandidates, isRsshubUrl, resolveCandidateUrl } from './rsshub';

export const PARSER_OPTIONS = {
	timeout: 10000,
	headers: {
		// Browser-like UA: many WordPress/Cloudflare fronted blogs (e.g.
		// kdnuggets.com) return 403 to library default UAs ("Mozilla/5.0"
		// alone or custom bot tokens) while serving real browsers fine.
		'User-Agent':
			'Mozilla/5.0 (compatible; charlens-rss/0.1; +https://github.com/nicodemus-opon/charlens)',
		Accept: 'application/rss+xml, application/xml, text/xml, */*'
	},
	// See $lib/server/net: Node's Happy Eyeballs stalls on broken-IPv6
	// networks (news.ycombinator.com ETIMEDOUT while curl works). rss-parser
	// forwards requestOptions to http/https.get, so pin DNS-order connects.
	requestOptions: { ...IPV4_COMPAT_REQUEST_OPTIONS },
	customFields: {
		item: [
			['content:encoded', 'contentEncoded'],
			['media:content', 'mediaContent'],
			['media:group', 'mediaGroup']
		]
	}
} satisfies ConstructorParameters<typeof Parser>[0];

/**
 * RSSHub cold-starts can exceed the default 10s parse timeout — YouTube
 * fulltext routes alone take >20s on first hit. Fetches against the RSSHub
 * instance get a full minute so radar-verified candidates aren't dropped as
 * "not a feed" while the instance is still warming up.
 */
export const RSSHUB_PARSE_TIMEOUT_MS = 60_000;

const parser = new Parser(PARSER_OPTIONS);
const rsshubParser = new Parser({ ...PARSER_OPTIONS, timeout: RSSHUB_PARSE_TIMEOUT_MS });
/**
 * Short-timeout parser for bulk discovery verification only: slow sites
 * must fail fast so a page of results settles in seconds, not minutes.
 * Ingest/preview paths keep the patient defaults above.
 */
const verifyParser = new Parser({ ...PARSER_OPTIONS, timeout: 5_000 });

/** Parser for a feed URL: RSSHub routes get the extended cold-start timeout. */
export function parseTimeoutFor(url: string): number {
	return isRsshubUrl(url) ? RSSHUB_PARSE_TIMEOUT_MS : PARSER_OPTIONS.timeout;
}

function parserFor(url: string, fast = false): Parser {
	if (isRsshubUrl(url)) return rsshubParser;
	return fast ? verifyParser : parser;
}

export interface ParsedFeed {
	title: string;
	siteUrl?: string;
	imageUrl?: string;
	items: ParsedItem[];
}

export interface ParsedItem {
	guid: string;
	title: string;
	link: string;
	author?: string;
	publishedAt?: Date;
	excerpt: string;
	contentHtml: string;
	imageUrl?: string | null;
	/** Raw feed `<category>` values, normalized into tags on ingest. */
	tags: string[];
}

/** Pin format=rss on RSSHub route URLs so rss-parser gets XML, not the HTML viewer. */
function pinRsshubFormat(url: string): string {
	if (!isRsshubUrl(url)) return url;
	try {
		const u = new URL(url);
		if (!u.searchParams.has('format')) u.searchParams.set('format', 'rss');
		return u.toString();
	} catch {
		return url;
	}
}

type RawFeed = Awaited<ReturnType<Parser['parseURL']>>;

async function parseUrl(url: string, fast = false): Promise<RawFeed> {
	const target = pinRsshubFormat(url);
	return parserFor(target, fast).parseURL(target);
}

/**
 * First candidate that parses to a real Date. Feeds regularly ship garbage
 * dates (`<pubDate>Invalid Date</pubDate>` on a cold RSSHub cache, empty
 * strings, duplicate tags that arrive as arrays). An unchecked `new Date()`
 * yields an Invalid Date that explodes later inside drizzle's timestamp
 * serialization, so validate here and treat undated/garbage-dated items as
 * "no date" (NULL in the db — list queries coalesce to arrival time).
 */
export function parseFeedDate(...candidates: unknown[]): Date | undefined {
	for (const c of candidates) {
		const raw = Array.isArray(c) ? c[0] : c;
		if (raw instanceof Date) {
			if (!Number.isNaN(raw.getTime())) return raw;
			continue;
		}
		if (typeof raw !== 'string' || raw.trim() === '') continue;
		const d = new Date(raw.trim());
		if (!Number.isNaN(d.getTime())) return d;
	}
	return undefined;
}

/** Map a raw rss-parser feed into the app's ParsedFeed shape. */
function toParsedFeed(raw: RawFeed, url: string): ParsedFeed {
	const items: ParsedItem[] = (raw.items ?? []).map((it, i) => {
		const fields = it as unknown as Record<string, unknown>;
		const content = fields['contentEncoded'] ?? it.content ?? it.contentSnippet ?? '';
		const html = sanitizeArticleHtml(typeof content === 'string' ? content : '');
		const imageUrl = pickImage(it as unknown as Parameters<typeof pickImage>[0]);
		return {
			guid: it.guid ?? it.link ?? `${it.title ?? 'item'}-${i}`,
			title: (it.title ?? 'Untitled').slice(0, 500),
			link: it.link ?? url,
			author: (fields['author'] as string | undefined) ?? it.creator,
			publishedAt: parseFeedDate(it.isoDate, it.pubDate),
			excerpt: (it.contentSnippet ?? excerptFrom(typeof content === 'string' ? content : '')).slice(
				0,
				500
			),
			contentHtml: stripDuplicateImage(html, imageUrl),
			imageUrl,
			tags: normalizeFeedTags(fields['categories'] ?? it.categories)
		};
	});
	return {
		title: raw.title ?? new URL(url).hostname,
		siteUrl: raw.link,
		imageUrl: raw.image?.url ?? faviconForUrl(raw.link ?? url),
		items
	};
}

export async function fetchFeed(url: string): Promise<ParsedFeed> {
	return toParsedFeed(await parseUrl(url), url);
}

/**
 * Best-effort real title for an already-resolved feed URL (used to replace
 * generic Radar rule titles like "Channel with user handle" with the actual
 * channel/feed name). Bounded by `budgetMs` so RSSHub cold starts can't stall
 * Discover — the loser keeps running but the race already settled, so its
 * late rejection is swallowed. Never throws.
 */
export async function fetchFeedTitle(url: string, budgetMs = 8_000): Promise<string | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const raw = await Promise.race([
			parseUrl(url),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('title budget exceeded')), budgetMs);
			})
		]);
		return toParsedFeed(raw, url).title || null;
	} catch {
		return null;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Classify a fetch/discovery error. Transient failures (timeouts, DNS blips,
 * connection resets, HTTP 5xx/429) mean "try again later"; everything else
 * (feed not recognized, 404) means the URL has no usable feed.
 *
 * ENOTFOUND/EAI_AGAIN count as transient on purpose: silently deleting a feed
 * the user just added during a DNS hiccup is worse than keeping a row that a
 * later retry (or the user) can remove. 419 counts as transient too: it is
 * the rate-limit status (e.g. Hacker News gating bot-like TLS clients while
 * browsers pass) — worth one more attempt, not a verdict.
 */
export function isTransientFeedError(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	const code = (e as NodeJS.ErrnoException).code ?? '';
	const text = `${e.message} ${code}`;
	// 403/401 are transient *for row retention*: bot-protection (Cloudflare /
	// WordPress) serves 403 to non-browser UAs while browsers work fine, and
	// polling blocks lift or are bypassed with a better UA. Deleting the user's
	// feed on a 403 would drop subscriptions that a retry could heal, so keep
	// the placeholder and let the scheduler retry.
	return /timed out|timeout|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|fetch failed|network error|Status code (5\d\d|429|419|408|40[13])/i.test(
		text
	);
}

/** Best-effort favicon fallback when a feed provides no image. */
export function faviconForUrl(
	siteUrl?: string | null,
	feedUrl?: string | null
): string | undefined {
	const raw = siteUrl?.trim() || feedUrl?.trim();
	if (!raw) return undefined;
	try {
		const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
		const host = new URL(withProto).hostname;
		if (!host) return undefined;
		return `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
	} catch {
		return undefined;
	}
}

const CANDIDATES = ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/blog/rss.xml'];

/**
 * Curated section feeds for high-value sites whose HTML is bot-walled
 * (PerimeterX/Cloudflare) so `<link rel="alternate">` discovery can't run,
 * while the feed endpoints themselves return 200 to the same UA.
 * Keys are bare hosts (no `www.`). Paths are verified live before display —
 * stale entries simply drop out. Add new sites here as they're reported.
 */
const KNOWN_SITE_FEEDS: Record<string, string[]> = {
	'bloomberg.com': [
		'/feeds/news.rss',
		'/feeds/business/news.rss',
		'/feeds/markets/news.rss',
		'/feeds/politics/news.rss',
		'/feeds/technology/news.rss',
		'/feeds/wealth/news.rss',
		'/feeds/crypto/news.rss',
		'/feeds/businessweek/news.rss',
		'/feeds/bview/news.rss'
	],
	// Human-readable /rss index lists section feeds (/rss/*.php) while the
	// homepage declares no `<link rel="alternate">` and /rss itself is HTML.
	'standardmedia.co.ke': [
		'/rss/headlines.php',
		'/rss/kenya.php',
		'/rss/world.php',
		'/rss/politics.php',
		'/rss/opinion.php',
		'/rss/sports.php',
		'/rss/business.php',
		'/rss/columnists.php',
		'/rss/magazines.php',
		'/rss/agriculture.php',
		'/rss/ktnvideos.php',
		'/rss/evewoman.php',
		'/rss/entertainment.php'
	]
};

/** A verified subscribable feed belonging to a site (title for display). */
export interface SiteFeed {
	url: string;
	title: string;
}

const SITE_FEEDS_CACHE_MS = 60 * 60 * 1000;
const siteFeedsCache = new Map<string, { at: number; feeds: SiteFeed[] }>();

/** Test-only: reset the site-feeds cache. */
export function _resetSiteFeedsCache() {
	siteFeedsCache.clear();
}

/**
 * Feed URLs declared by an HTML page via `<link rel="alternate">`
 * (e.g. `/news/feed/` on sites whose feed lives off the common paths).
 * Pure (tests) — fetching lives in `discoverSiteFeeds`.
 */
export function extractFeedLinks(html: string, baseUrl: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const tagRe = /<link\b[^>]{0,2000}>/gi;
	let m: RegExpExecArray | null;
	while ((m = tagRe.exec(html)) !== null) {
		const tag = m[0];
		if (!/\brel\s*=\s*["']?alternate["']?/i.test(tag)) continue;
		const type = /type\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
		if (type !== '' && !/rss|atom|xml|json|feed/.test(type)) continue;
		const href = /href\s*=\s*["']([^"']{1,2000})["']/i.exec(tag)?.[1];
		if (!href) continue;
		try {
			const abs = new URL(href, baseUrl).toString();
			if (!abs.startsWith('http')) continue;
			if (!seen.has(abs) && out.length < 10) {
				seen.add(abs);
				out.push(abs);
			}
		} catch {
			// relative URL against a broken base — skip
		}
	}
	return out;
}

/**
 * Feed-looking `<a href>` links on a human-readable RSS index page
 * (e.g. standardmedia.co.ke/rss lists `/rss/*.php` section feeds while the
 * homepage declares no `<link rel="alternate">`). Matches hrefs containing
 * rss/atom/feed or ending in .xml/.rss — verified with a real parse later,
 * so false positives simply drop out. Pure (tests).
 */
export function extractFeedAnchorLinks(html: string, baseUrl: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const anchorRe = /<a\b[^>]{0,2000}href\s*=\s*["']([^"']{1,2000})["'][^>]{0,2000}>/gi;
	let m: RegExpExecArray | null;
	while ((m = anchorRe.exec(html)) !== null) {
		const href = m[1];
		if (!/rss|atom|feed|\.xml(\?|#|$)|\.rss(\?|#|$)/.test(href.toLowerCase())) {
			// StandardMedia-style `/rss/*.php` section feeds have no feed-ish
			// extension — match them by path instead.
			if (!/\/rss\//.test(href.toLowerCase())) continue;
		}
		try {
			const abs = new URL(href, baseUrl).toString();
			if (!abs.startsWith('http')) continue;
			if (!seen.has(abs) && out.length < 20) {
				seen.add(abs);
				out.push(abs);
			}
		} catch {
			// relative URL against a broken base — skip
		}
	}
	return out;
}

/**
 * Fetch a page for feed discovery: HTML (up to 500kB) plus the final URL
 * after redirects. Null on any failure. The final URL matters: a pasted
 * bare domain (`infoq.com`) redirects to `www`, and section/anchor
 * extraction must run against the canonical host or same-origin checks
 * silently drop everything.
 */
async function fetchPage(
	pageUrl: string,
	timeoutMs: number
): Promise<{ html: string; finalUrl: string } | null> {
	// fetchExternal (not global fetch): undici's Happy Eyeballs stalls on
	// broken-IPv6 networks where rss-parser's http.get path succeeds, so
	// page fetches must use the same hardened transport as feed parsing.
	try {
		const res = await fetchExternal(pageUrl, {
			timeoutMs,
			headers: {
				'User-Agent': PARSER_OPTIONS.headers['User-Agent'],
				Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
			}
		});
		if (res.status < 200 || res.status >= 300) return null;
		const contentType = res.contentType ?? '';
		if (contentType !== '' && !/html|xml|rss|atom|feed|text/.test(contentType.toLowerCase())) {
			return null;
		}
		return { html: res.body.toString('utf-8').slice(0, 500_000), finalUrl: res.finalUrl };
	} catch {
		return null;
	}
}

/** Fetch a site page and list its declared feeds. Never throws. Exported for URL discovery. */
export async function discoverSiteFeeds(
	siteUrl: string,
	timeoutMs = PARSER_OPTIONS.timeout
): Promise<string[]> {
	const page = await fetchPage(siteUrl, timeoutMs);
	return page === null ? [] : extractFeedLinks(page.html, page.finalUrl);
}

/**
 * Fetch a human-readable page (site root, `/rss` index, …) and list
 * feed-looking `<a href>` links on it. Never throws. Companions
 * `discoverSiteFeeds` (which only reads `<link rel="alternate">`).
 */
export async function discoverAnchorFeeds(pageUrl: string, timeoutMs = 5_000): Promise<string[]> {
	const page = await fetchPage(pageUrl, timeoutMs);
	return page === null ? [] : extractFeedAnchorLinks(page.html, page.finalUrl);
}

/** First path segments that are site chrome, not content sections. */
const SECTION_DENY = new Set([
	'login',
	'signin',
	'sign-in',
	'signup',
	'sign-up',
	'register',
	'registration',
	'auth',
	'oauth',
	'sso',
	'search',
	'api',
	'static',
	'assets',
	'cdn',
	'images',
	'img',
	'css',
	'js',
	'fonts',
	'privacy',
	'privacy-notice',
	'terms',
	'cookies',
	'cookie-policy',
	'legal',
	'sitemap',
	'contact',
	'about',
	'help',
	'faq',
	'faqs',
	'support',
	'advertise',
	'advertising',
	'careers',
	'jobs',
	'subscribe',
	'newsletter',
	'newsletters',
	'unsubscribe',
	'account',
	'profile',
	'settings',
	'admin',
	'dashboard',
	'user',
	'users',
	'page',
	'comments',
	'shop',
	'cart',
	'checkout',
	'pricing'
]);

/** Whole section paths that are feed indexes themselves, not content sections. */
const SECTION_PATH_DENY = new Set(['/rss', '/feed', '/feeds', '/atom', '/rss.xml', '/feed.xml']);

/**
 * Content-section paths from a page's same-origin nav links (e.g. `/java`,
 * `/news`, `/category/tech`): candidates for section-feed probing. `<nav>`
 * links come first — they are the site's real sections, while document
 * order typically leads with footer/utility links. Skips feed-looking hrefs
 * (handled by anchor discovery), deep article URLs, files, and site chrome.
 * Capped. Pure (tests).
 */
export function extractSectionPaths(html: string, origin: string, limit = 10): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	let base: URL;
	try {
		base = new URL(origin);
	} catch {
		return [];
	}
	// Nav-first ordering: collect hrefs from <nav> blocks, then the whole
	// page (deduped, nav wins). Keeps footer links like /privacy-notice
	// from crowding real sections past the cap.
	const anchorRe = /<a\b[^>]{0,2000}href\s*=\s*["']([^"']{1,2000})["'][^>]{0,2000}>/gi;
	const hrefsIn = (scope: string): string[] => {
		const hrefs: string[] = [];
		anchorRe.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = anchorRe.exec(scope)) !== null) hrefs.push(m[1].trim());
		return hrefs;
	};
	const navScopes: string[] = [];
	const navRe = /<nav\b[^>]*>([\s\S]*?)<\/nav>/gi;
	let nm: RegExpExecArray | null;
	while ((nm = navRe.exec(html)) !== null) navScopes.push(nm[1]);
	const ordered = [...navScopes.flatMap(hrefsIn), ...hrefsIn(html)];
	for (const rawHref of ordered) {
		if (out.length >= limit) break;
		if (
			rawHref === '' ||
			rawHref.startsWith('#') ||
			/^(mailto|javascript|tel|sms):/i.test(rawHref) ||
			rawHref.includes('?')
		) {
			continue;
		}
		let url: URL;
		try {
			url = new URL(rawHref, origin);
		} catch {
			continue;
		}
		if (url.origin !== base.origin) continue;
		const path = url.pathname.replace(/\/+$/, '') || '/';
		if (path === '/' || SECTION_PATH_DENY.has(path.toLowerCase())) continue;
		if (/rss|atom|\/feed(\/|$)/i.test(path)) continue;
		const segs = path.split('/').filter(Boolean);
		if (segs.length < 1 || segs.length > 2) continue;
		const first = segs[0].toLowerCase();
		if (SECTION_DENY.has(first) || /^\d+$/.test(first)) continue;
		const last = segs[segs.length - 1];
		if (last.includes('.')) continue;
		if (!seen.has(path) && out.length < limit) {
			seen.add(path);
			out.push(path);
		}
	}
	return out;
}

/**
 * Section-feed URL conventions, `{S}` = section path with leading slash:
 * WordPress (`/category/tech/feed`), Ghost-ish (`/tag/x/rss`), InfoQ-style
 * (`/rss/java`, `/feed/java`). Probed per nav section and verified with a
 * real parse, so non-matching conventions fail fast as 404s. No per-site
 * hardcoding — the site's own nav supplies the sections.
 */
const SECTION_FEED_PATTERNS = ['{S}/feed', '{S}/rss', '/rss{S}', '/feed{S}'];

/** Sections probed with every convention before learning the site's style. */
const SECTION_LEARN_COUNT = 2;

/**
 * Which section-feed patterns to use for the remaining sections, given
 * round-A results. Patterns that verified nothing are dropped (their 404s
 * taught us the convention doesn't apply); when several patterns hit but
 * every hit is content-identical (alias URLs like `/rss/java` vs
 * `/feed/java`), only the first is kept. With no hits at all, all patterns
 * are kept — the remaining probes will be fast 404s anyway. Pure (tests).
 */
export function selectPatterns(
	roundA: { pattern: string; fingerprint: string | null }[],
	patterns: string[] = SECTION_FEED_PATTERNS
): string[] {
	const hitPrints = new Map<string, Set<string>>();
	for (const r of roundA) {
		if (r.fingerprint === null) continue;
		let set = hitPrints.get(r.pattern);
		if (!set) {
			set = new Set();
			hitPrints.set(r.pattern, set);
		}
		set.add(r.fingerprint);
	}
	const survivors = patterns.filter((p) => hitPrints.has(p));
	if (survivors.length === 0) return [...patterns];
	if (survivors.length > 1) {
		const all = new Set<string>();
		for (const p of survivors) for (const f of hitPrints.get(p) ?? []) all.add(f);
		if (all.size === 1) return [survivors[0]];
	}
	return survivors;
}

export interface QuickVerifyResult {
	/** 'ok' (feed parses), 'retry' (transient failure — bot-wall/timeout), 'no' (definitive). */
	status: 'ok' | 'retry' | 'no';
	/** Verified feed URL when status is 'ok'. */
	url?: string;
}

/**
 * Fast feed existence check for bulk discovery verification: direct parse,
 * then declared `<link rel="alternate">` feeds, then a few common paths.
 * Skips RSSHub (cold starts are far too slow for bulk use). Bounded by the
 * 10s parser timeout per attempt. Never throws.
 */
export async function quickVerifyFeed(siteUrl: string): Promise<QuickVerifyResult> {
	let withProto = siteUrl.trim();
	if (!/^https?:\/\//i.test(withProto)) withProto = `https://${withProto}`;
	try {
		new URL(withProto);
	} catch {
		return { status: 'no' };
	}
	// Verification favors speed over thoroughness (5s timeouts, parallel
	// path probes, 15s total budget): an unlucky site reports `retry`
	// (transient: the row stays actionable) instead of stalling the page.
	// Full discovery for Preview/Follow uses the patient defaults.
	const started = Date.now();
	const SITE_BUDGET_MS = 15_000;
	const overBudget = () => {
		if (Date.now() - started > SITE_BUDGET_MS) {
			transient = true;
			return true;
		}
		return false;
	};
	let transient = false;
	try {
		await parseUrl(withProto, true);
		return { status: 'ok', url: withProto };
	} catch (e) {
		if (isTransientFeedError(e)) transient = true;
	}
	const base = withProto.replace(/\/+$/, '');
	const declared = await discoverSiteFeeds(withProto, 5_000);
	for (const candidate of declared.slice(0, 5)) {
		if (overBudget()) break;
		try {
			await parseUrl(candidate, true);
			return { status: 'ok', url: candidate };
		} catch (e) {
			if (isTransientFeedError(e)) transient = true;
			continue;
		}
	}
	if (!overBudget()) {
		const settled = await Promise.allSettled(
			CANDIDATES.slice(0, 3).map((p) => parseUrl(`${base}${p}`, true))
		);
		for (let i = 0; i < settled.length; i++) {
			const r = settled[i];
			if (r.status === 'fulfilled') return { status: 'ok', url: `${base}${CANDIDATES[i]}` };
		}
		for (const r of settled) {
			if (r.status === 'rejected' && isTransientFeedError(r.reason)) {
				transient = true;
				break;
			}
		}
	}
	return { status: transient ? 'retry' : 'no' };
}

/**
 * Classify the pasted URL itself: is it directly a feed (`ok`, with its
 * title), temporarily unreadable (`retry` — bot-wall/timeout, keep the row
 * so the user can still follow), or definitively not a feed (`no` — an HTML
 * page or 404, so callers can hide the redundant "Direct feed" row when real
 * alternatives exist). Fast timeout, never throws.
 */
export async function checkDirectFeed(
	url: string
): Promise<{ status: 'ok' | 'retry' | 'no'; title?: string }> {
	let withProto = url.trim();
	if (!/^https?:\/\//i.test(withProto)) withProto = `https://${withProto}`;
	try {
		new URL(withProto);
	} catch {
		return { status: 'no' };
	}
	try {
		const raw = await parseUrl(withProto, true);
		let title: string | undefined;
		try {
			title = toParsedFeed(raw, withProto).title;
		} catch {
			// title extraction is best-effort; the parse itself succeeded
		}
		return { status: 'ok', title };
	} catch (e) {
		return { status: isTransientFeedError(e) ? 'retry' : 'no' };
	}
}

/**
 * List every verified native feed belonging to a site, for any site:
 * declared `<link rel="alternate">` feeds, feed-looking links on
 * human-readable RSS index pages (`/rss`, `/feeds`), well-known paths,
 * section feeds found by probing common feed conventions against the site's
 * own nav sections (`/category/tech/feed`, `/rss/java`, …), plus curated
 * fallbacks for bot-walled hosts (see KNOWN_SITE_FEEDS). Each candidate is
 * verified with a real parse (fast 5s timeout, concurrency-capped) so the
 * URL-mode Discover page can present one row per feed instead of a single
 * first-match. Results are cached for an hour. Never throws.
 */
export async function discoverAllSiteFeeds(siteUrl: string): Promise<SiteFeed[]> {
	let withProto = siteUrl.trim();
	if (!/^https?:\/\//i.test(withProto)) withProto = `https://${withProto}`;
	let parsedBase: URL;
	try {
		parsedBase = new URL(withProto);
	} catch {
		return [];
	}
	// Full-URL cache key (normalized): declared feeds belong to the pasted
	// page, so youtube.com/@A and youtube.com/@B must not share an entry.
	const cacheKey = withProto.replace(/\/+$/, '');
	const now = Date.now();
	const cached = siteFeedsCache.get(cacheKey);
	if (cached && now - cached.at < SITE_FEEDS_CACHE_MS) return cached.feeds;

	const seen = new Set<string>();
	const probes: string[] = [];
	const pushProbe = (u: string) => {
		if (!seen.has(u) && probes.length < 50) {
			seen.add(u);
			probes.push(u);
		}
	};

	// The three page fetches are independent — run them together. Probe
	// building happens after all resolve, in priority order: curated feeds
	// first so junk links can't push them past the probe cap. Everything
	// resolves against the canonical origin (final URL after redirects), so
	// a pasted bare domain that redirects to `www` still matches its own
	// nav links.
	let learnProbes: { url: string; pattern: string }[] = [];
	let restSections: string[] = [];
	let origin = parsedBase.origin;
	try {
		const pastedOrigin = parsedBase.origin;
		const [pasted, rssPage, feedsPage] = await Promise.all([
			fetchPage(withProto, 5_000),
			fetchPage(`${pastedOrigin}/rss`, 5_000),
			fetchPage(`${pastedOrigin}/feeds`, 5_000)
		]);
		if (pasted !== null) {
			try {
				origin = new URL(pasted.finalUrl).origin;
			} catch {
				// keep the pasted origin
			}
			for (const u of extractFeedLinks(pasted.html, pasted.finalUrl)) pushProbe(u);
		}
		const host = parsedBase.hostname.toLowerCase().replace(/^www\./, '');
		for (const path of KNOWN_SITE_FEEDS[host] ?? []) {
			try {
				pushProbe(new URL(path, origin).toString());
			} catch {
				// skip malformed curated entries
			}
		}
		if (pasted !== null) {
			for (const u of extractFeedAnchorLinks(pasted.html, pasted.finalUrl)) pushProbe(u);
		}
		if (rssPage !== null) {
			for (const u of extractFeedAnchorLinks(rssPage.html, rssPage.finalUrl)) pushProbe(u);
		}
		if (feedsPage !== null) {
			for (const u of extractFeedAnchorLinks(feedsPage.html, feedsPage.finalUrl)) pushProbe(u);
		}
		// Section feeds: the site's own nav supplies section paths; common
		// feed conventions are probed per section. Non-matching conventions
		// fail fast (404), matching ones verify below. The first sections
		// are probed with every convention to learn the site's style
		// (`selectPatterns` narrows the rest) — this halves the slow probes
		// on sites like InfoQ instead of hammering every alias.
		if (pasted !== null) {
			const sections = extractSectionPaths(pasted.html, origin);
			for (const section of sections.slice(0, SECTION_LEARN_COUNT)) {
				for (const pattern of SECTION_FEED_PATTERNS) {
					const u = `${origin}${pattern.replace('{S}', section)}`;
					if (!seen.has(u) && probes.length < 50) {
						seen.add(u);
						probes.push(u);
						learnProbes.push({ url: u, pattern });
					}
				}
			}
			restSections = sections.slice(SECTION_LEARN_COUNT);
		}
		// Well-known paths resolve against the canonical origin: appending
		// them to a deep page URL (…/@handle/feed) would probe nonsense.
		for (const path of CANDIDATES) pushProbe(`${origin}${path}`);
	} catch {
		// never throws inside, defensive only
	}

	const feeds: SiteFeed[] = [];
	/** Content fingerprint per verified URL, for identical-feed collapsing. */
	const fingerprints = new Map<string, string>();
	const CONCURRENCY = 8;
	// Flaky hosts (e.g. standardmedia.co.ke serves some section feeds slowly)
	// fail individual probes with transient timeouts while succeeding on
	// retry — so transient failures get one more attempt instead of silently
	// dropping real feeds from the results.
	const retryQueue: string[] = [];
	const verifyBatch = async (batch: string[], fast: boolean) => {
		const settled = await Promise.allSettled(
			batch.map(async (u) => ({ url: u, raw: await parseUrl(u, fast) }))
		);
		settled.forEach((r, n) => {
			const url = batch[n];
			if (r.status !== 'fulfilled') {
				if (isTransientFeedError(r.reason)) retryQueue.push(url);
				return;
			}
			try {
				const parsed = toParsedFeed(r.value.raw, r.value.url);
				// Empty channels (e.g. stub index feeds) are subscribable but
				// useless on a discovery page — skip them.
				if (parsed.items.length === 0) return;
				feeds.push({ url: r.value.url, title: parsed.title });
				fingerprints.set(
					r.value.url,
					`${parsed.items.length}|${parsed.items
						.slice(0, 5)
						.map((i) => i.link)
						.join('|')}`
				);
			} catch {
				// not a feed — skip
			}
		});
	};
	for (let i = 0; i < probes.length; i += CONCURRENCY) {
		await verifyBatch(probes.slice(i, i + CONCURRENCY), true);
	}
	// Round B: remaining sections use only the conventions that verified in
	// round A (learned above) — same coverage, far fewer slow probes.
	if (restSections.length > 0) {
		const survivors = selectPatterns(
			learnProbes.map(({ url, pattern }) => ({
				pattern,
				fingerprint: fingerprints.get(url) ?? null
			}))
		);
		const roundBStart = probes.length;
		for (const section of restSections) {
			for (const pattern of survivors) {
				pushProbe(`${origin}${pattern.replace('{S}', section)}`);
			}
		}
		for (let i = roundBStart; i < probes.length; i += CONCURRENCY) {
			await verifyBatch(probes.slice(i, i + CONCURRENCY), true);
		}
	}
	const seenFeed = new Set(feeds.map((f) => f.url));
	// Snapshot: retry failures must not re-queue into further passes (each
	// probe gets exactly one retry, bounding the added latency). The patient
	// timeout is for slow-but-alive site feeds only — RSSHub routes keep the
	// fast timeout so a cold instance can't stall discovery for a minute.
	const retries = retryQueue.splice(0, retryQueue.length).filter((u) => !seenFeed.has(u));
	for (let i = 0; i < retries.length; i += CONCURRENCY) {
		const batch = retries.slice(i, i + CONCURRENCY);
		const before = feeds.length;
		const queuedBefore = retryQueue.length;
		await verifyBatch(
			batch.filter((u) => !isRsshubUrl(u)),
			false
		);
		await verifyBatch(
			batch.filter((u) => isRsshubUrl(u)),
			true
		);
		retryQueue.length = queuedBefore;
		for (const f of feeds.slice(before)) seenFeed.add(f.url);
	}
	// Stable order: curated/declared discovery order is already
	// most-relevant-first; keep it (no relevance sort here). Collapse URLs
	// serving byte-identical content (`/feed` vs `/rss` vs `/rss.xml` on the
	// same host) to the shortest URL so the page doesn't show the same feed
	// four times. Sections that merely share a lead story have different
	// item sets and are kept.
	const deduped = new Map<string, SiteFeed>();
	for (const f of feeds) {
		const key = fingerprints.get(f.url) ?? f.url;
		const prev = deduped.get(key);
		if (!prev || f.url.length < prev.url.length) deduped.set(key, f);
	}
	const unique = [...deduped.values()];
	if (siteFeedsCache.size >= 200) {
		const oldest = siteFeedsCache.keys().next();
		if (!oldest.done) siteFeedsCache.delete(oldest.value);
	}
	siteFeedsCache.set(cacheKey, { at: Date.now(), feeds: unique });
	return unique;
}

export interface DiscoverResult {
	/** Best feed URL: a verified parse target, a resolved RSSHub route, or the raw input. */
	url: string;
	/** True when discovery itself parsed the feed successfully (`parsed` is set then). */
	verified: boolean;
	/** The verified parse, so callers can avoid refetching immediately. */
	parsed: ParsedFeed | null;
	/** True when the RSSHub Radar lookup errored (instance down) rather than found no rule. */
	radarFailed: boolean;
	/**
	 * True when a fetch failed transiently (timeout, 5xx/429, or 401/403
	 * bot-protection) rather than definitively (404, not-a-feed). Callers
	 * show a "retry later" message instead of "no feed here".
	 */
	transient: boolean;
}

/**
 * Find a subscribable feed URL for a pasted site URL, channel page, or feed
 * link. Tries the input directly, then the page's declared
 * `<link rel="alternate">` feeds, then well-known paths, then RSSHub Radar
 * rules — verifying each candidate with a real parse, using the extended
 * RSSHub timeout for instance routes so cold starts aren't misclassified.
 * Never throws; reports what was verified so callers can decide whether a
 * later failure is retryable (keep the placeholder) or definitive (delete it).
 */
export async function discoverFeed(input: string): Promise<DiscoverResult> {
	const trimmed = input.trim();
	let withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	withProto = pinRsshubFormat(withProto);
	let transient = false;
	// Try direct first (also covers pasted RSSHub route URLs).
	try {
		const parsed = toParsedFeed(await parseUrl(withProto), withProto);
		return { url: withProto, verified: true, parsed, radarFailed: false, transient: false };
	} catch (e) {
		if (isTransientFeedError(e)) transient = true;
		// fall through to candidates if input looks like a site root
	}
	const base = withProto.replace(/\/+$/, '');
	// Declared feeds first: `<link rel="alternate">` finds feeds that live
	// off the common paths (e.g. `/news/feed/`).
	for (const declared of await discoverSiteFeeds(withProto)) {
		try {
			const parsed = toParsedFeed(await parseUrl(declared), declared);
			return { url: declared, verified: true, parsed, radarFailed: false, transient: false };
		} catch (e) {
			if (isTransientFeedError(e)) transient = true;
			continue;
		}
	}
	for (const path of CANDIDATES) {
		try {
			const candidate = `${base}${path}`;
			const parsed = toParsedFeed(await parseUrl(candidate), candidate);
			return { url: candidate, verified: true, parsed, radarFailed: false, transient: false };
		} catch (e) {
			if (isTransientFeedError(e)) transient = true;
			continue;
		}
	}
	// Last resort: ask the self-hosted RSSHub instance (Radar rules) whether
	// this site maps to a route, and verify the suggestion parses.
	// Templates whose params were extracted from the pasted URL (prefill)
	// resolve to concrete URLs and are verified the same way; templates
	// without values are skipped. When verification fails transiently the
	// resolved route is still returned as the best-effort URL so callers can
	// persist it and let the scheduler retry instead of falling back to an
	// HTML page.
	let radarFailed = false;
	let resolvedFallback: string | null = null;
	try {
		const { candidates, failed } = await getRadarCandidates(withProto);
		radarFailed = failed;
		for (const c of candidates.slice(0, 3)) {
			const resolved = resolveCandidateUrl(c);
			if (!resolved) continue;
			resolvedFallback ??= resolved;
			try {
				const parsed = toParsedFeed(await parseUrl(resolved), resolved);
				return { url: resolved, verified: true, parsed, radarFailed, transient: false };
			} catch (e) {
				if (isTransientFeedError(e)) transient = true;
				continue;
			}
		}
	} catch {
		radarFailed = true;
	}
	return {
		url: resolvedFallback ?? withProto,
		verified: false,
		parsed: null,
		radarFailed,
		transient
	};
}
