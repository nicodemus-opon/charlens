// Shared OPML 2.0 feed backup: build + parse (no DOM/DB imports —
// unit-testable and safe to import from server endpoints and actions).
//
// Scope: feed URLs + titles + manual-collection grouping. Tags, read state,
// settings and smart-view rules are intentionally out of scope.

export interface OpmlFeedInput {
	url: string;
	title?: string | null;
	collection?: string | null;
}

export interface OpmlEntry {
	/** Trimmed http(s) feed URL. */
	url: string;
	/** Display title (falls back to the URL). */
	title: string;
	/** Collection name (falls back to the default). */
	collection: string;
}

/** Rejects uploads larger than this before parsing. */
export const OPML_MAX_BYTES = 2 * 1024 * 1024;
/** Upper bound on feeds accepted from a single file. */
export const OPML_MAX_FEEDS = 500;
export const OPML_DEFAULT_COLLECTION = 'General';

const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 256;
const MAX_COLLECTION_LENGTH = 100;

export class OpmlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OpmlError';
	}
}

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function decodeEntities(value: string): string {
	return value.replace(/&(#\d+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, body: string) => {
		switch (body) {
			case 'amp':
				return '&';
			case 'lt':
				return '<';
			case 'gt':
				return '>';
			case 'quot':
				return '"';
			case 'apos':
				return "'";
			default:
				if (body.startsWith('#x') || body.startsWith('#X')) {
					const code = parseInt(body.slice(2), 16);
					return Number.isFinite(code) ? String.fromCodePoint(code) : m;
				}
				{
					const code = parseInt(body.slice(1), 10);
					return Number.isFinite(code) ? String.fromCodePoint(code) : m;
				}
		}
	});
}

function cleanTitle(title: string | null | undefined, fallback: string): string {
	const clean = (title ?? '').trim().slice(0, MAX_TITLE_LENGTH).trim();
	return clean || fallback;
}

function cleanCollection(name: string | null | undefined): string {
	const clean = (name ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_COLLECTION_LENGTH).trim();
	return clean || OPML_DEFAULT_COLLECTION;
}

/** Build an OPML 2.0 document, grouping feeds under their collection. */
export function buildOpml(feeds: OpmlFeedInput[]): string {
	const groups = new Map<string, { title: string; url: string }[]>();
	for (const f of feeds) {
		const url = (f.url ?? '').trim();
		if (!url) continue;
		const collection = cleanCollection(f.collection);
		const list = groups.get(collection) ?? [];
		list.push({ title: cleanTitle(f.title, url), url });
		groups.set(collection, list);
	}
	const lines: string[] = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<opml version="2.0">',
		'\t<head>',
		'\t\t<title>charlens feeds</title>',
		'\t</head>',
		'\t<body>'
	];
	for (const [collection, items] of groups) {
		const name = escapeAttr(collection);
		lines.push(`\t\t<outline text="${name}" title="${name}">`);
		for (const item of items) {
			const title = escapeAttr(item.title);
			const url = escapeAttr(item.url);
			lines.push(
				`\t\t\t<outline type="rss" text="${title}" title="${title}" xmlUrl="${url}" htmlUrl="${url}"/>`
			);
		}
		lines.push('\t\t</outline>');
	}
	lines.push('\t</body>', '</opml>');
	return lines.join('\n');
}

function parseOutlineAttrs(tag: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(tag)) !== null) {
		const name = m[1].toLowerCase();
		const value = m[3] !== undefined ? m[3] : m[4];
		if (!(name in attrs)) attrs[name] = decodeEntities(value);
	}
	return attrs;
}

function isHttpUrl(url: string): boolean {
	return /^https?:\/\/[^/\s]+/i.test(url);
}

/**
 * Parse an OPML document into feed entries. Nested group outlines resolve to
 * the innermost group name. Throws OpmlError on oversize/non-OPML/empty input.
 */
export function parseOpml(xml: string): OpmlEntry[] {
	if (typeof xml !== 'string' || xml.trim() === '') {
		throw new OpmlError('The file is empty.');
	}
	if (xml.length > OPML_MAX_BYTES) {
		throw new OpmlError('The file is too large (max 2 MB).');
	}
	if (!/<opml[\s>]/i.test(xml)) {
		throw new OpmlError('Not an OPML file.');
	}
	const entries: OpmlEntry[] = [];
	const seen = new Set<string>();
	const stack: (string | null)[] = [];
	const re = /<(\/?)outline\b([^>]*?)(\/?)>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null) {
		const closing = m[1] === '/';
		const attrText = m[2] ?? '';
		const selfClosing = m[3] === '/';
		if (closing) {
			stack.pop();
			continue;
		}
		const attrs = parseOutlineAttrs(attrText);
		const rawUrl = (attrs['xmlurl'] ?? attrs['url'] ?? '').trim();
		if (rawUrl) {
			if (
				rawUrl.length <= MAX_URL_LENGTH &&
				isHttpUrl(rawUrl) &&
				!seen.has(rawUrl) &&
				entries.length < OPML_MAX_FEEDS
			) {
				seen.add(rawUrl);
				const group = [...stack].reverse().find((g) => g != null) ?? null;
				entries.push({
					url: rawUrl,
					title: cleanTitle(attrs['text'] ?? attrs['title'], rawUrl),
					collection: cleanCollection(group)
				});
			}
			// A feed outline with children is rare; keep the tag stack balanced.
			if (!selfClosing) stack.push(null);
			continue;
		}
		if (selfClosing) continue;
		const groupName = (attrs['text'] ?? attrs['title'] ?? '').trim();
		stack.push(groupName ? groupName.slice(0, MAX_COLLECTION_LENGTH).trim() || null : null);
	}
	if (entries.length === 0) {
		throw new OpmlError('No feeds found in this file.');
	}
	return entries;
}
