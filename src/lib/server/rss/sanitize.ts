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

export function pickImage(item: {
	enclosure?: { url?: string };
	media?: unknown;
	image?: unknown;
	content?: string;
	'content:encoded'?: string;
}): string | null {
	if (typeof item.enclosure?.url === 'string') return item.enclosure.url;
	const html = item['content:encoded'] ?? item.content;
	if (typeof html === 'string') {
		const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
		if (m?.[1] && m[1].startsWith('http')) return m[1];
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
