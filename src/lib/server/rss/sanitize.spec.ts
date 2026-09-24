import { describe, expect, it } from 'vitest';
import { excerptFrom, pickImage, sanitizeArticleHtml, stripDuplicateImage } from './sanitize';

describe('sanitizeArticleHtml', () => {
	it('strips scripts but keeps links with safe rel', () => {
		const out = sanitizeArticleHtml(
			'<p>hi</p><script>alert(1)</script><a href="https://x.com">x</a>'
		);
		expect(out).not.toContain('<script>');
		expect(out).toContain('target="_blank"');
		expect(out).toContain('rel="noopener noreferrer"');
	});
});

describe('excerptFrom', () => {
	it('strips tags and collapses whitespace', () => {
		expect(excerptFrom('<p>hello   <b>world</b></p>')).toBe('hello world');
	});
});

describe('pickImage', () => {
	it('prefers enclosure url', () => {
		expect(pickImage({ enclosure: { url: 'https://img.test/a.jpg' } })).toBe(
			'https://img.test/a.jpg'
		);
	});
	it('falls back to first content image', () => {
		expect(pickImage({ content: '<p><img src="https://img.test/b.png"></p>' })).toBe(
			'https://img.test/b.png'
		);
	});
});

describe('stripDuplicateImage', () => {
	it('removes the body img matching the hero imageUrl', () => {
		const html =
			'<p><img src="https://img.test/a.jpg"></p><p>body text</p><p><img src="https://img.test/other.jpg"></p>';
		const out = stripDuplicateImage(html, 'https://img.test/a.jpg');
		expect(out).not.toContain('https://img.test/a.jpg');
		expect(out).toContain('https://img.test/other.jpg');
		expect(out).toContain('body text');
	});
	it('keeps distinct body images untouched', () => {
		const html = '<p><img src="https://img.test/b.jpg"></p>';
		expect(stripDuplicateImage(html, 'https://img.test/a.jpg')).toBe(html);
	});
	it('handles empty inputs', () => {
		expect(stripDuplicateImage('', 'https://img.test/a.jpg')).toBe('');
		expect(stripDuplicateImage('<p>x</p>', null)).toBe('<p>x</p>');
	});
});
