import { describe, expect, it } from 'vitest';
import { extractFromHtml, looksTruncated } from './scrape';

const FIXTURE = `<!doctype html><html><head>
<meta name="author" content="Jane Doe">
<meta property="og:image" content="https://img.test/cover.jpg">
<meta property="article:published_time" content="2026-01-02T10:00:00.000Z">
</head><body><nav>menu</nav>
<article><h1>Hello</h1><p>First paragraph of the story.</p><p>Second paragraph.</p></article>
<script>alert(1)</script>
</body></html>`;

describe('extractFromHtml', () => {
	it('extracts body, author, image and date', () => {
		const out = extractFromHtml(FIXTURE, 'https://example.com/a');
		expect(out.contentHtml).toContain('First paragraph');
		expect(out.contentHtml).not.toContain('alert(1)');
		expect(out.contentHtml).not.toContain('menu');
		expect(out.author).toBe('Jane Doe');
		expect(out.imageUrl).toBe('https://img.test/cover.jpg');
		expect(out.publishedAt?.toISOString()).toBe('2026-01-02T10:00:00.000Z');
		expect(out.excerpt.length).toBeGreaterThan(0);
	});

	it('falls back to paragraphs when no article tag', () => {
		const out = extractFromHtml('<html><body><p>solo</p></body></html>', 'https://x.test/');
		expect(out.contentHtml).toContain('solo');
	});
});

describe('looksTruncated', () => {
	it('flags empty or excerpt-only bodies', () => {
		expect(looksTruncated('', 'hi')).toBe(true);
		expect(looksTruncated('<p>hi</p>', 'hi')).toBe(true);
		expect(looksTruncated(`<p>${'x'.repeat(2000)}</p>`, 'short')).toBe(false);
	});
});
