import { describe, expect, it } from 'vitest';
import {
	PARSER_OPTIONS,
	RSSHUB_PARSE_TIMEOUT_MS,
	checkDirectFeed,
	discoverAllSiteFeeds,
	extractFeedAnchorLinks,
	extractFeedLinks,
	extractSectionPaths,
	selectPatterns,
	faviconForUrl,
	fetchFeedTitle,
	isTransientFeedError,
	parseFeedDate,
	parseTimeoutFor
} from './parser';

describe('PARSER_OPTIONS (broken-IPv6 hardening)', () => {
	it('disables Happy Eyeballs so hosts like news.ycombinator.com connect', () => {
		// rss-parser forwards requestOptions to http/https.get. Without this,
		// adds "succeed" but land 0 articles (ETIMEDOUT, kept as transient).
		expect(PARSER_OPTIONS.requestOptions).toMatchObject({ autoSelectFamily: false });
	});
});

describe('parseTimeoutFor (RSSHub cold-start timeout)', () => {
	it('gives RSSHub instance routes the extended 60s timeout', () => {
		expect(RSSHUB_PARSE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
		expect(parseTimeoutFor('http://localhost:1200/youtube/user/@t3dotgg?format=rss')).toBe(
			RSSHUB_PARSE_TIMEOUT_MS
		);
	});

	it('keeps the 10s default for direct feed urls', () => {
		expect(parseTimeoutFor('https://example.com/feed.xml')).toBe(10_000);
	});
});

describe('isTransientFeedError', () => {
	it('treats timeouts as retryable', () => {
		expect(isTransientFeedError(new Error('Request timed out after 60000ms'))).toBe(true);
		expect(isTransientFeedError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe(true);
	});

	it('treats connection and DNS failures as retryable', () => {
		expect(
			isTransientFeedError(
				Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
			)
		).toBe(true);
		expect(
			isTransientFeedError(Object.assign(new Error('getaddrinfo failed'), { code: 'EAI_AGAIN' }))
		).toBe(true);
		expect(
			isTransientFeedError(Object.assign(new Error('dns lookup failed'), { code: 'ENOTFOUND' }))
		).toBe(true);
	});

	it('treats server-side http failures as retryable', () => {
		expect(isTransientFeedError(new Error('Status code 503'))).toBe(true);
		expect(isTransientFeedError(new Error('Status code 429'))).toBe(true);
		expect(isTransientFeedError(new Error('Status code 419'))).toBe(true);
	});

	it('treats bot-protection 403 as retryable (keeps the row for scheduler retry)', () => {
		expect(isTransientFeedError(new Error('Status code 403'))).toBe(true);
	});

	it('treats non-feed responses and client errors as definitive', () => {
		expect(isTransientFeedError(new Error('Feed not recognized as RSS 1 or 2.'))).toBe(false);
		expect(isTransientFeedError(new Error('default RSS version not recognized.'))).toBe(false);
		expect(isTransientFeedError(new Error('Status code 404'))).toBe(false);
		expect(isTransientFeedError(new Error('Too many redirects'))).toBe(false);
	});

	it('rejects non-errors', () => {
		expect(isTransientFeedError('boom')).toBe(false);
		expect(isTransientFeedError(null)).toBe(false);
		expect(isTransientFeedError(undefined)).toBe(false);
	});
});

describe('parseFeedDate (invalid pubDate guard)', () => {
	it('parses a valid ISO date', () => {
		expect(parseFeedDate('2026-09-24T01:01:21.000Z')?.toISOString()).toBe(
			'2026-09-24T01:01:21.000Z'
		);
	});

	it('parses a valid RSS pubDate', () => {
		expect(parseFeedDate('Wed, 23 Sep 2026 18:02:21 GMT')?.toISOString()).toBe(
			'2026-09-23T18:02:21.000Z'
		);
	});

	it('prefers the first parseable candidate', () => {
		expect(parseFeedDate('not a date', 'Wed, 23 Sep 2026 18:02:21 GMT')?.toISOString()).toBe(
			'2026-09-23T18:02:21.000Z'
		);
	});

	it('returns undefined for garbage instead of an Invalid Date', () => {
		// RSSHub emits this verbatim when its upstream cache has no date.
		expect(parseFeedDate('Invalid Date')).toBeUndefined();
		expect(parseFeedDate('0000-00-00')).toBeUndefined();
		expect(parseFeedDate('definitely not a date')).toBeUndefined();
	});

	it('skips non-string candidates (duplicate tags arrive as arrays)', () => {
		expect(parseFeedDate(['Wed, 23 Sep 2026 18:02:21 GMT'])?.toISOString()).toBe(
			'2026-09-23T18:02:21.000Z'
		);
		expect(parseFeedDate({}, null, 42)).toBeUndefined();
	});

	it('returns undefined when nothing parses', () => {
		expect(parseFeedDate(undefined, undefined)).toBeUndefined();
		expect(parseFeedDate('', '  ')).toBeUndefined();
	});

	it('passes through Date instances but rejects invalid ones', () => {
		const d = new Date('2026-09-23T18:02:21.000Z');
		expect(parseFeedDate(d)).toBe(d);
		expect(parseFeedDate(new Date(NaN))).toBeUndefined();
	});
});

describe('faviconForUrl', () => {
	it('builds a favicon url from the site host', () => {
		expect(faviconForUrl('https://www.example.com/blog')).toContain('domain=www.example.com');
	});

	it('returns undefined without a usable url', () => {
		expect(faviconForUrl(undefined, undefined)).toBeUndefined();
		expect(faviconForUrl('not a url')).toBeUndefined();
	});
});

describe('extractFeedLinks (declared-feed discovery)', () => {
	const html = `
		<html><head>
		<link rel="alternate" type="application/rss+xml" title="News" href="/news/feed/" />
		<link rel="alternate" type="application/atom+xml" href="https://example.com/atom.xml" />
		<link rel="stylesheet" href="/style.css" />
		<link rel="alternate" type="text/html" href="/about" />
		</head></html>`;

	it('collects rss/atom links and resolves relative hrefs', () => {
		expect(extractFeedLinks(html, 'https://example.com/')).toStrictEqual([
			'https://example.com/news/feed/',
			'https://example.com/atom.xml'
		]);
	});

	it('ignores stylesheets and non-feed alternates', () => {
		expect(
			extractFeedLinks('<link rel="stylesheet" href="/a.css" />', 'https://x.test')
		).toStrictEqual([]);
	});

	it('returns empty for pages without declared feeds', () => {
		expect(extractFeedLinks('<html><head></head></html>', 'https://x.test')).toStrictEqual([]);
	});

	it('collects up to 10 declared feeds (multi-feed sites)', () => {
		const links = Array.from(
			{ length: 12 },
			(_, i) =>
				`<link rel="alternate" type="application/rss+xml" href="https://x.test/f${i}.xml" />`
		).join('\n');
		expect(extractFeedLinks(`<html><head>${links}</head></html>`, 'https://x.test')).toHaveLength(
			10
		);
	});
});

describe('extractFeedAnchorLinks (rss-index discovery)', () => {
	it('collects standardmedia-style /rss/*.php section feeds', () => {
		const html = `
			<html><body>
			<a href="https://www.standardmedia.co.ke/rss/headlines.php">headlines</a>
			<a href="/rss/kenya.php">kenya</a>
			<a href="https://www.standardmedia.co.ke/national/article/123">an article</a>
			</body></html>`;
		expect(extractFeedAnchorLinks(html, 'https://www.standardmedia.co.ke/rss')).toStrictEqual([
			'https://www.standardmedia.co.ke/rss/headlines.php',
			'https://www.standardmedia.co.ke/rss/kenya.php'
		]);
	});

	it('collects generic rss/atom/feed hrefs and resolves relative urls', () => {
		const html = `
			<html><body>
			<a href="/blog/feed/">blog feed</a>
			<a href="https://x.test/atom.xml">atom</a>
			<a href="/about">about</a>
			</body></html>`;
		expect(extractFeedAnchorLinks(html, 'https://x.test/')).toStrictEqual([
			'https://x.test/blog/feed/',
			'https://x.test/atom.xml'
		]);
	});

	it('returns empty when no feed-looking links exist', () => {
		expect(
			extractFeedAnchorLinks('<html><body><a href="/about">a</a></body></html>', 'https://x.test')
		).toStrictEqual([]);
	});
});

describe('extractSectionPaths (nav-section discovery)', () => {
	const origin = 'https://www.infoq.com';

	it('collects single- and two-level content sections in document order', () => {
		const html = `
			<html><body><nav>
			<a href="/news/">News</a>
			<a href="https://www.infoq.com/java/">Java</a>
			<a href="/category/tech/">Tech</a>
			</nav></body></html>`;
		expect(extractSectionPaths(html, origin)).toStrictEqual(['/news', '/java', '/category/tech']);
	});

	it('skips external links, articles, files, queries, and site chrome', () => {
		const html = `
			<html><body>
			<a href="https://external.com/java/">x</a>
			<a href="/news/2024/10/some-article">article</a>
			<a href="/assets/app.css">css</a>
			<a href="/login">login</a>
			<a href="/search?q=x">search</a>
			<a href="/about">about</a>
			<a href="/feed">feed index</a>
			<a href="/rss/java">already a feed</a>
			<a href="mailto:a@b.c">mail</a>
			<a href="#">empty</a>
			<a href="/devops/">DevOps</a>
			</body></html>`;
		expect(extractSectionPaths(html, origin)).toStrictEqual(['/devops']);
	});

	it('prefers nav links over footer links in document order', () => {
		const html = `
			<html><body>
			<a href="/privacy-notice">privacy</a>
			<a href="/jobs">jobs</a>
			<nav><a href="/java/">Java</a><a href="/news/">News</a></nav>
			<a href="/about">about</a>
			</body></html>`;
		expect(extractSectionPaths(html, origin)).toStrictEqual(['/java', '/news']);
	});

	it('caps sections and dedupes repeats', () => {
		const links = Array.from({ length: 15 }, (_, i) => `<a href="/s${i}/">s</a>`).join('');
		expect(extractSectionPaths(`<html><body>${links}</body></html>`, origin)).toHaveLength(10);
		const dupes = '<a href="/java/">a</a><a href="/java/">b</a>';
		expect(extractSectionPaths(`<html><body>${dupes}</body></html>`, origin)).toStrictEqual([
			'/java'
		]);
	});

	it('returns empty for garbage origins', () => {
		expect(extractSectionPaths('<a href="/x">x</a>', 'not a url [[[ Value')).toStrictEqual([]);
	});
});

describe('selectPatterns (convention learning)', () => {
	const P = ['{S}/feed', '{S}/rss', '/rss{S}', '/feed{S}'];

	it('keeps only patterns that verified', () => {
		const roundA = [
			{ pattern: '{S}/feed', fingerprint: null },
			{ pattern: '/rss{S}', fingerprint: 'fp1' }
		];
		expect(selectPatterns(roundA, P)).toStrictEqual(['/rss{S}']);
	});

	it('collapses alias patterns with identical content to the first', () => {
		const roundA = [
			{ pattern: '/rss{S}', fingerprint: 'same' },
			{ pattern: '/feed{S}', fingerprint: 'same' }
		];
		expect(selectPatterns(roundA, P)).toStrictEqual(['/rss{S}']);
	});

	it('keeps distinct patterns with different content', () => {
		const roundA = [
			{ pattern: '{S}/feed', fingerprint: 'a' },
			{ pattern: '/rss{S}', fingerprint: 'b' }
		];
		expect(selectPatterns(roundA, P)).toStrictEqual(['{S}/feed', '/rss{S}']);
	});

	it('falls back to all patterns when nothing verified', () => {
		const roundA = [
			{ pattern: '{S}/feed', fingerprint: null },
			{ pattern: '/rss{S}', fingerprint: null }
		];
		expect(selectPatterns(roundA, P)).toStrictEqual(P);
	});
});

describe('discoverAllSiteFeeds', () => {
	it('returns empty for garbage input without network', async () => {
		await expect(discoverAllSiteFeeds('not a url [[[ Value')).resolves.toStrictEqual([]);
	});
});

describe('checkDirectFeed', () => {
	it('reports garbage input as definitively not a feed', async () => {
		await expect(checkDirectFeed('not a url [[[ Value')).resolves.toStrictEqual({
			status: 'no'
		});
	});
});

describe('fetchFeedTitle', () => {
	it('returns null for garbage input without hanging', async () => {
		await expect(fetchFeedTitle('not a url [[[ Value', 1000)).resolves.toBeNull();
	});
});
