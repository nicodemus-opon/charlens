import { describe, expect, it } from 'vitest';
import { buildFetchUrl, isFeedStale, isPlaceholderFeed } from './refresh';
import {
	_resetSchedulerForTests,
	getRefreshIntervalMs,
	getSchedulerStatus,
	isSchedulerEnabled
} from './scheduler';

describe('isFeedStale', () => {
	it('treats missing timestamps as stale', () => {
		expect(isFeedStale(null)).toBe(true);
		expect(isFeedStale(undefined)).toBe(true);
	});

	it('honors force and the 15-minute window', () => {
		const now = Date.now();
		expect(isFeedStale(new Date(now - 60_000), true, now)).toBe(true);
		expect(isFeedStale(new Date(now - 60_000), false, now)).toBe(false);
		expect(isFeedStale(new Date(now - 16 * 60_000), false, now)).toBe(true);
	});
});

describe('buildFetchUrl', () => {
	it('pins format=rss for rsshub feeds', () => {
		expect(buildFetchUrl({ url: 'http://localhost:1200/x/y', source: 'rsshub' })).toContain(
			'format=rss'
		);
	});

	it('leaves plain rss urls untouched', () => {
		expect(buildFetchUrl({ url: 'https://example.com/feed.xml', source: 'rss' })).toBe(
			'https://example.com/feed.xml'
		);
	});

	it('keeps an explicit format param', () => {
		const out = buildFetchUrl({
			url: 'http://localhost:1200/x/y?format=atom',
			source: 'rsshub'
		});
		expect(out).toContain('format=atom');
	});
});

describe('isPlaceholderFeed', () => {
	it('flags rows still carrying the hostname title written by addFeed', () => {
		expect(
			isPlaceholderFeed({
				url: 'http://localhost:1200/youtube/user/@t3dotgg?format=rss',
				siteUrl: 'https://www.youtube.com',
				title: 'www.youtube.com'
			})
		).toBe(true);
		expect(
			isPlaceholderFeed({
				url: 'https://example.com',
				siteUrl: null,
				title: 'https://example.com'
			})
		).toBe(true);
		expect(isPlaceholderFeed({ url: 'https://example.com/feed', siteUrl: null, title: null })).toBe(
			true
		);
	});

	it('passes feeds with a real title', () => {
		expect(
			isPlaceholderFeed({
				url: 'http://localhost:1200/youtube/user/@t3dotgg?format=rss',
				siteUrl: 'https://www.youtube.com',
				title: 't3․gg - YouTube'
			})
		).toBe(false);
		expect(
			isPlaceholderFeed({
				url: 'https://example.com/feed.xml',
				siteUrl: 'https://example.com',
				title: 'Example Engineering Blog'
			})
		).toBe(false);
	});
});

describe('scheduler config', () => {
	it('reports stopped status before start', () => {
		_resetSchedulerForTests();
		const status = getSchedulerStatus();
		expect(status.running).toBe(false);
		expect(status.intervalMs).toBe(getRefreshIntervalMs());
		expect(typeof isSchedulerEnabled()).toBe('boolean');
		_resetSchedulerForTests();
	});
});
