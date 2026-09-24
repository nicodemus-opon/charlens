import { excerptFrom, sanitizeArticleHtml, stripDuplicateImage } from './sanitize';

export interface ScrapedArticle {
	contentHtml: string;
	excerpt: string;
	imageUrl: string | null;
	author?: string;
	publishedAt?: Date;
}

const MAX_HTML_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 15000;

function metaContent(html: string, attr: string, name: string): string | null {
	const re = new RegExp(
		`<meta[^>]+${attr}=["']${name}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*${attr}=["']${name}["']`,
		'i'
	);
	const m = html.match(re);
	return (m?.[1] ?? m?.[2] ?? null)?.trim() || null;
}

function timeDatetime(html: string): string | null {
	const m = html.match(/<time[^>]+datetime=["']([^"']+)["']/i);
	return m?.[1]?.trim() || null;
}

function firstImgSrc(html: string): string | null {
	const m = html.match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i);
	return m?.[1] ?? null;
}

function stripNoise(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<nav[\s\S]*?<\/nav>/gi, '')
		.replace(/<header[\s\S]*?<\/header>/gi, '')
		.replace(/<footer[\s\S]*?<\/footer>/gi, '');
}

/** Pure HTML → article extraction (no network). Testable with fixtures. */
export function extractFromHtml(html: string, url: string): ScrapedArticle {
	const author =
		metaContent(html, 'name', 'author') ??
		metaContent(html, 'property', 'article:author') ??
		metaContent(html, 'name', 'twitter:creator') ??
		undefined;
	const imageUrl = metaContent(html, 'property', 'og:image') ?? firstImgSrc(html);
	const dateRaw =
		metaContent(html, 'property', 'article:published_time') ??
		metaContent(html, 'name', 'publish_date') ??
		timeDatetime(html);
	let publishedAt: Date | undefined;
	if (dateRaw) {
		const d = new Date(dateRaw);
		if (!Number.isNaN(d.getTime())) publishedAt = d;
	}
	const clean = stripNoise(html);
	const pick = (tag: string): string | null => {
		const m = clean.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
		return m?.[1]?.trim() ? m[0] : null;
	};
	// Prefer semantic containers; fall back to concatenated paragraphs.
	const rawBody = pick('article') ?? pick('main') ?? null;
	let bodyHtml: string;
	if (rawBody) {
		bodyHtml = rawBody;
	} else {
		const paras = [...clean.matchAll(/<p[^>]*>[\s\S]*?<\/p>/gi)].map((m) => m[0]).slice(0, 40);
		bodyHtml = paras.length > 0 ? paras.join('\n') : clean.slice(0, 20000);
	}
	// Resolve relative image/link URLs against the article URL.
	try {
		const base = new URL(url);
		bodyHtml = bodyHtml.replace(/(src|href)=["'](\/[^"']*)["']/gi, `$1="${base.origin}$2"`);
	} catch {
		// keep as-is when the article URL is unusual
	}
	const contentHtml = stripDuplicateImage(sanitizeArticleHtml(bodyHtml).slice(0, 200000), imageUrl);
	return {
		contentHtml,
		excerpt: excerptFrom(contentHtml).slice(0, 500),
		imageUrl,
		author: author?.slice(0, 200),
		publishedAt
	};
}

async function fetchArticleHtml(url: string): Promise<string> {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		throw new Error('Invalid article URL');
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Unsupported protocol');
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(u.toString(), {
			signal: ctrl.signal,
			redirect: 'follow',
			headers: {
				'User-Agent': 'charlens-rss/0.1 (+fulltext)',
				Accept: 'text/html,application/xhtml+xml'
			}
		});
		if (!res.ok) throw new Error(`fetch ${res.status}`);
		const type = res.headers.get('content-type') ?? '';
		if (type && !/html|xml|text/.test(type)) throw new Error(`unsupported content-type ${type}`);
		const buf = await res.arrayBuffer();
		if (buf.byteLength > MAX_HTML_BYTES) throw new Error('article HTML too large');
		return new TextDecoder('utf-8').decode(buf.slice(0, MAX_HTML_BYTES));
	} finally {
		clearTimeout(t);
	}
}

/** Fetch an article link and extract full text + metadata. Sanitized. */
export async function scrapeArticle(url: string): Promise<ScrapedArticle> {
	const html = await fetchArticleHtml(url);
	return extractFromHtml(html, url);
}

/** Heuristic: feeds that only ship excerpts need the full-text fallback. */
export function looksTruncated(contentHtml: string | null, excerpt: string | null): boolean {
	const len = (contentHtml ?? '').replace(/<[^>]+>/g, '').trim().length;
	if (len === 0) return true;
	if (len < 500 && (excerpt ?? '').trim().length >= len - 20) return true;
	return false;
}
