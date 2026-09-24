import { describe, expect, it } from 'vitest';
import { IPV4_COMPAT_REQUEST_OPTIONS, fetchExternal } from './net';

describe('IPV4_COMPAT_REQUEST_OPTIONS', () => {
	it('disables Happy Eyeballs family autoselection', () => {
		// Regression guard for https://news.ycombinator.com/rss landing
		// 0 articles: Node's autoSelectFamily stalls (ETIMEDOUT) on
		// broken-IPv6 networks while curl/python connect fine.
		expect(IPV4_COMPAT_REQUEST_OPTIONS).toEqual({ autoSelectFamily: false });
	});
});

describe('fetchExternal validation (no network)', () => {
	it('rejects invalid urls', async () => {
		await expect(fetchExternal('not a url')).rejects.toThrow('Invalid article URL');
	});

	it('rejects unsupported protocols', async () => {
		await expect(fetchExternal('ftp://example.com/x')).rejects.toThrow('Unsupported protocol');
	});
});
