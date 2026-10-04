import { describe, expect, it } from 'vitest';
import { parseLocale, parseNewsSources, siteRoot } from './feed-search';

describe('parseLocale', () => {
	it('extracts language and region', () => {
		expect(parseLocale('en-KE,en;q=0.9')).toStrictEqual({ lang: 'en', region: 'KE' });
		expect(parseLocale('fr-SN')).toStrictEqual({ lang: 'fr', region: 'SN' });
	});
	it('falls back to en-US without a region', () => {
		expect(parseLocale('en')).toStrictEqual({ lang: 'en', region: 'US' });
		expect(parseLocale(null)).toStrictEqual({ lang: 'en', region: 'US' });
		expect(parseLocale('')).toStrictEqual({ lang: 'en', region: 'US' });
		expect(parseLocale('garbage!!!')).toStrictEqual({ lang: 'en', region: 'US' });
	});
});

describe('siteRoot', () => {
	it('normalizes urls to their https origin', () => {
		expect(siteRoot('http://www.nation.africa/kenya/news')).toBe('https://www.nation.africa');
		expect(siteRoot('https://citizen.digital/')).toBe('https://citizen.digital');
	});
	it('returns null for garbage', () => {
		expect(siteRoot('not a url')).toBeNull();
		expect(siteRoot('ftp://files.example.com/x')).toBeNull();
		expect(siteRoot('')).toBeNull();
	});
});

describe('parseNewsSources (Google News RSS)', () => {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
		<rss version="2.0"><channel>
		<item><title>A story</title><link>https://example.com/a</link>
		<source url="https://nation.africa">Daily Nation</source></item>
		<item><title>Another</title><link>https://example.com/b</link>
		<source url="https://nation.africa/world">Daily Nation</source></item>
		<item><title>Third</title><link>https://example.com/c</link>
		<source url="https://citizen.digital">Citizen Digital</source></item>
		</channel></rss>`;

	it('extracts publisher names with site roots', () => {
		expect(parseNewsSources(xml)).toStrictEqual([
			{ name: 'Daily Nation', siteUrl: 'https://nation.africa' },
			{ name: 'Citizen Digital', siteUrl: 'https://citizen.digital' }
		]);
	});

	it('dedupes repeat publishers', () => {
		const sites = parseNewsSources(xml);
		expect(sites.filter((s) => s.siteUrl === 'https://nation.africa')).toHaveLength(1);
	});

	it('returns empty for payloads without sources', () => {
		expect(parseNewsSources('<rss><channel></channel></rss>')).toStrictEqual([]);
		expect(parseNewsSources('')).toStrictEqual([]);
	});

	it('drops placeholder source names', () => {
		const xml = `<rss><channel>
			<item><source url="https://junk.example">Articles</source></item>
			<item><source url="https://real.example">Real Outlet</source></item>
		</channel></rss>`;
		expect(parseNewsSources(xml)).toStrictEqual([
			{ name: 'Real Outlet', siteUrl: 'https://real.example' }
		]);
	});

	it('drops platform hosts that are not followable feeds', () => {
		const xml = `<rss><channel>
			<item><source url="https://www.facebook.com/story">facebook.com</source></item>
			<item><source url="https://real.example">Real Outlet</source></item>
		</channel></rss>`;
		expect(parseNewsSources(xml)).toStrictEqual([
			{ name: 'Real Outlet', siteUrl: 'https://real.example' }
		]);
	});
});
