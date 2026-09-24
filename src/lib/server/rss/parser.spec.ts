import { describe, expect, it } from 'vitest';
import {
	PARSER_OPTIONS,
	RSSHUB_PARSE_TIMEOUT_MS,
	faviconForUrl,
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
