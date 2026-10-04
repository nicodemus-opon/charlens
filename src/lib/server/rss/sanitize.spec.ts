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
	it('decodes entities in content image urls', () => {
		expect(
			pickImage({
				content: '<p><img src="https://img.test/c.png?quality=90&#038;strip=all"></p>'
			})
		).toBe('https://img.test/c.png?quality=90&strip=all');
	});
	it('skips relative content images for later absolute ones', () => {
		expect(
			pickImage({
				content: '<p><img src="/thumb.png"></p><p><img src="https://img.test/d.png"></p>'
			})
		).toBe('https://img.test/d.png');
	});
	it('reads youtube-style media group thumbnails', () => {
		expect(
			pickImage({
				mediaGroup: {
					'media:content': [
						{
							$: {
								url: 'https://www.youtube.com/v/abc?version=3',
								type: 'application/x-shockwave-flash'
							}
						}
					],
					'media:thumbnail': [{ $: { url: 'https://i4.ytimg.com/vi/abc/hqdefault.jpg' } }]
				}
			})
		).toBe('https://i4.ytimg.com/vi/abc/hqdefault.jpg');
	});
	it('reads top-level media content images', () => {
		expect(
			pickImage({ mediaContent: { $: { url: 'https://img.test/e.jpg', medium: 'image' } } })
		).toBe('https://img.test/e.jpg');
	});
	it('still prefers enclosure over media', () => {
		expect(
			pickImage({
				enclosure: { url: 'https://img.test/a.jpg' },
				mediaContent: { $: { url: 'https://img.test/e.jpg', medium: 'image' } }
			})
		).toBe('https://img.test/a.jpg');
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
