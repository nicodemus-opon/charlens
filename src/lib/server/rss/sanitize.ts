import sanitizeHtml from 'sanitize-html';

export function sanitizeArticleHtml(dirty: string | null | undefined): string {
	if (!dirty) return '';
	return sanitizeHtml(dirty, {
		allowedTags: sanitizeHtml.defaults.allowedTags.concat([
			'img',
			'h1',
			'h2',
			'h3',
			'figure',
			'figcaption',
			'pre',
			'code',
			'blockquote'
		]),
		allowedAttributes: {
			...sanitizeHtml.defaults.allowedAttributes,
			a: ['href', 'title', 'target', 'rel'],
			img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
			pre: ['class'],
			code: ['class']
		},
		allowedSchemes: ['http', 'https', 'mailto'],
		transformTags: {
			a: (tagName, attribs) => ({
				tagName,
				attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' }
			})
		}
	});
}

export function excerptFrom(html: string | null | undefined, fallback = ''): string {
	const source = html ?? fallback;
	if (!source) return '';
	const text = sanitizeHtml(source, { allowedTags: [] });
	return text.replace(/\s+/g, ' ').trim().slice(0, 220);
}

/** Decode HTML entities that leak into feed `<img src>` values (`&#038;`, `&amp;`). */
function decodeAttrEntities(s: string): string {
	return s
		.replace(/&amp;/gi, '&')
		.replace(/&quot;/gi, '"')
		.replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>');
}

/**
 * Pull an http(s) url out of rss-parser media shapes: bare strings,
 * `{ $: { url } }` attribute bags, or arrays of either. Attachments that
 * declare a non-image type/medium (e.g. YouTube's flash `media:content`)
 * are skipped.
 */
function mediaUrl(value: unknown): string | null {
	if (typeof value === 'string') return value.startsWith('http') ? value : null;
	if (Array.isArray(value)) {
		for (const v of value) {
			const u = mediaUrl(v);
			if (u) return u;
		}
		return null;
	}
	if (value && typeof value === 'object') {
		const o = value as Record<string, unknown>;
		const dollar = o['$'];
		const attrs: Record<string, unknown> = {
			...(typeof dollar === 'object' && dollar !== null
				? (dollar as Record<string, unknown>)
				: null),
			...o
		};
		const medium = attrs['medium'];
		if (typeof medium === 'string' && medium !== '' && medium !== 'image') return null;
		const type = attrs['type'];
		if (typeof type === 'string' && type !== '' && !type.startsWith('image/')) return null;
		const url = attrs['url'];
		if (typeof url === 'string' && url.startsWith('http')) return url;
	}
	return null;
}

export function pickImage(item: {
	enclosure?: { url?: string } | { url?: string }[];
	mediaContent?: unknown;
	mediaGroup?: unknown;
	mediaThumbnail?: unknown;
	media?: unknown;
	image?: unknown;
	content?: string;
	'content:encoded'?: string;
}): string | null {
	const enclosures = Array.isArray(item.enclosure) ? item.enclosure : [item.enclosure];
	for (const e of enclosures) {
		if (typeof e?.url === 'string' && e.url.startsWith('http')) return e.url;
	}
	// Media RSS (including YouTube's `media:group`): thumbnails first, then
	// declared content; the group's flash-player `media:content` is skipped
	// by the type guard in `mediaUrl`.
	const group =
		item.mediaGroup && typeof item.mediaGroup === 'object'
			? (item.mediaGroup as Record<string, unknown>)
			: null;
	if (group) {
		for (const key of ['media:thumbnail', 'thumbnail']) {
			const u = mediaUrl(group[key]);
			if (u) return decodeAttrEntities(u);
		}
	}
	for (const m of [item.mediaThumbnail, item.mediaContent, item.media, item.image]) {
		const u = mediaUrl(m);
		if (u) return decodeAttrEntities(u);
	}
	if (group) {
		const u = mediaUrl(group['media:content']);
		if (u) return decodeAttrEntities(u);
	}
	const html = item['content:encoded'] ?? item.content;
	if (typeof html === 'string') {
		const re = /<img[^>]+src=["']([^"']+)["']/gi;
		let m: RegExpExecArray | null;
		while ((m = re.exec(html)) !== null) {
			const decoded = decodeAttrEntities(m[1]);
			if (decoded.startsWith('http')) return decoded;
		}
	}
	return null;
}

/**
 * Remove `<img>` tags from `html` whose `src` matches `imageUrl`.
 *
 * The reader renders `imageUrl` as a hero image above the body, while
 * `pickImage` / `og:image` often point at the very same file that is also
 * embedded as the first `<img>` in the body — showing it twice. Stripping
 * the matching body image keeps a single hero copy.
 *
 * Only exact URL matches (modulo `&` vs `&amp;` encoding) are removed, so
 * distinct body images are left untouched. Empty `<figure>` wrappers left
 * behind are cleaned up as well.
 */
export function stripDuplicateImage(
	html: string | null | undefined,
	imageUrl: string | null | undefined
): string {
	if (!html || !imageUrl) return html ?? '';
	const trimmed = imageUrl.trim();
	if (!trimmed) return html;
	const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// HTML may encode `&` as `&amp;` inside attributes — match either form.
	const flexible = escaped.replace(/&(amp;)?/g, '(?:&amp;|&)');
	const imgRe = new RegExp(`<img[^>]*src=(["'])${flexible}\\1[^>]*\\/?>`, 'gi');
	let out = html.replace(imgRe, '');
	// Drop figure/picture wrappers left empty after the removal.
	out = out.replace(/<figure[^>]*>\s*(?:<figcaption[^>]*>\s*<\/figcaption>\s*)?<\/figure>/gi, '');
	out = out.replace(/<picture[^>]*>\s*<\/picture>/gi, '');
	return out;
}
