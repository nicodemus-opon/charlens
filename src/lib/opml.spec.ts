import { describe, expect, it } from 'vitest';
import { buildOpml, OpmlError, parseOpml } from './opml';

describe('opml', () => {
	it('builds grouped OPML and round-trips through the parser', () => {
		const xml = buildOpml([
			{ url: 'https://example.com/a.xml', title: 'A', collection: 'Tech' },
			{ url: 'https://example.com/b.xml', title: 'B', collection: 'Tech' },
			{ url: 'https://example.com/c.xml', title: 'C', collection: 'News' }
		]);
		expect(xml).toContain('<opml version="2.0">');
		const entries = parseOpml(xml);
		expect(entries).toHaveLength(3);
		expect(entries.filter((e) => e.collection === 'Tech')).toHaveLength(2);
		expect(entries.find((e) => e.url === 'https://example.com/c.xml')?.collection).toBe('News');
	});

	it('escapes and decodes XML entities', () => {
		const xml = buildOpml([
			{ url: 'https://example.com/?a=1&b=2', title: 'Fish & "Chips" <yum>', collection: 'A&B' }
		]);
		expect(xml).toContain('Fish &amp; &quot;Chips&quot; &lt;yum&gt;');
		const [entry] = parseOpml(xml);
		expect(entry.title).toBe('Fish & "Chips" <yum>');
		expect(entry.collection).toBe('A&B');
		expect(entry.url).toBe('https://example.com/?a=1&b=2');
	});

	it('resolves nested groups to the innermost name', () => {
		const entries = parseOpml(
			`<?xml version="1.0"?><opml version="2.0"><head><title>x</title></head><body>` +
				`<outline text="Outer"><outline text="Inner">` +
				`<outline text="Feed" xmlUrl="https://example.com/f.xml"/>` +
				`</outline></outline></body></opml>`
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].collection).toBe('Inner');
	});

	it('parses single-quote attributes and url fallback', () => {
		const entries = parseOpml(
			`<opml version="1.0"><body><outline text='Solo' url='https://example.com/s.xml'/></body></opml>`
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].title).toBe('Solo');
		expect(entries[0].collection).toBe('General');
	});

	it('drops non-http URLs, blanks and duplicates', () => {
		const entries = parseOpml(
			`<opml version="2.0"><body>` +
				`<outline text="A" xmlUrl="https://example.com/a.xml"/>` +
				`<outline text="A dup" xmlUrl="https://example.com/a.xml"/>` +
				`<outline text="ftp" xmlUrl="ftp://example.com/f.xml"/>` +
				`<outline text="no url"/>` +
				`</body></opml>`
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].url).toBe('https://example.com/a.xml');
	});

	it('rejects empty, non-OPML and feed-less input', () => {
		expect(() => parseOpml('')).toThrow(OpmlError);
		expect(() => parseOpml('<rss><channel></channel></rss>')).toThrow('Not an OPML file.');
		expect(() => parseOpml('<opml version="2.0"><body></body></opml>')).toThrow('No feeds found');
	});

	it('rejects oversize input', () => {
		expect(() => parseOpml('<opml version="2.0"><body>' + ' '.repeat(3 * 1024 * 1024))).toThrow(
			'too large'
		);
	});
});
