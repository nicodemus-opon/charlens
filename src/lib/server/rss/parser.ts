import Parser from 'rss-parser';
import { normalizeFeedTags } from '$lib/tags';
import { IPV4_COMPAT_REQUEST_OPTIONS } from '$lib/server/net';
import { excerptFrom, pickImage, sanitizeArticleHtml, stripDuplicateImage } from './sanitize';
import { getRadarCandidates, isRsshubUrl, resolveCandidateUrl } from './rsshub';

export const PARSER_OPTIONS = {
	timeout: 10000,
	headers: { 'User-Agent': 'charlens-rss/0.1 (+mvp)' },
	// See $lib/server/net: Node's Happy Eyeballs stalls on broken-IPv6
	// networks (news.ycombinator.com ETIMEDOUT while curl works). rss-parser
	// forwards requestOptions to http/https.get, so pin DNS-order connects.
	requestOptions: { ...IPV4_COMPAT_REQUEST_OPTIONS },
	customFields: {
		item: [
			['content:encoded', 'contentEncoded'],
			['media:content', 'mediaContent']
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

/** Parser for a feed URL: RSSHub routes get the extended cold-start timeout. */
export function parseTimeoutFor(url: string): number {
	return isRsshubUrl(url) ? RSSHUB_PARSE_TIMEOUT_MS : PARSER_OPTIONS.timeout;
}

function parserFor(url: string): Parser {
	return isRsshubUrl(url) ? rsshubParser : parser;
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

async function parseUrl(url: string): Promise<RawFeed> {
	const target = pinRsshubFormat(url);
	return parserFor(target).parseURL(target);
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
 * Classify a fetch/discovery error. Transient failures (timeouts, DNS blips,
 * connection resets, HTTP 5xx/429) mean "try again later"; everything else
 * (feed not recognized, 404) means the URL has no usable feed.
 *
 * ENOTFOUND/EAI_AGAIN count as transient on purpose: silently deleting a feed
 * the user just added during a DNS hiccup is worse than keeping a row that a
 * later retry (or the user) can remove.
 */
export function isTransientFeedError(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	const code = (e as NodeJS.ErrnoException).code ?? '';
	const text = `${e.message} ${code}`;
	return /timed out|timeout|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|fetch failed|network error|Status code (5\d\d|429|408)/i.test(
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

export interface DiscoverResult {
	/** Best feed URL: a verified parse target, a resolved RSSHub route, or the raw input. */
	url: string;
	/** True when discovery itself parsed the feed successfully (`parsed` is set then). */
	verified: boolean;
	/** The verified parse, so callers can avoid refetching immediately. */
	parsed: ParsedFeed | null;
	/** True when the RSSHub Radar lookup errored (instance down) rather than found no rule. */
	radarFailed: boolean;
}

/**
 * Find a subscribable feed URL for a pasted site URL, channel page, or feed
 * link. Tries the input directly, then well-known paths, then RSSHub Radar
 * rules — verifying each candidate with a real parse, using the extended
 * RSSHub timeout for instance routes so cold starts aren't misclassified.
 * Never throws; reports what was verified so callers can decide whether a
 * later failure is retryable (keep the placeholder) or definitive (delete it).
 */
export async function discoverFeed(input: string): Promise<DiscoverResult> {
	const trimmed = input.trim();
	let withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	withProto = pinRsshubFormat(withProto);
	// Try direct first (also covers pasted RSSHub route URLs).
	try {
		const parsed = toParsedFeed(await parseUrl(withProto), withProto);
		return { url: withProto, verified: true, parsed, radarFailed: false };
	} catch {
		// fall through to candidates if input looks like a site root
	}
	const base = withProto.replace(/\/+$/, '');
	for (const path of CANDIDATES) {
		try {
			const candidate = `${base}${path}`;
			const parsed = toParsedFeed(await parseUrl(candidate), candidate);
			return { url: candidate, verified: true, parsed, radarFailed: false };
		} catch {
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
				return { url: resolved, verified: true, parsed, radarFailed };
			} catch {
				continue;
			}
		}
	} catch {
		radarFailed = true;
	}
	return { url: resolvedFallback ?? withProto, verified: false, parsed: null, radarFailed };
}
