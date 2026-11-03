import { describe, expect, it } from 'vitest';
import { API_TOKEN_PREFIX, hashApiToken, mintPlaintext } from '$lib/server/api/auth';
import { checkRateLimit, _resetRateLimitsForTests } from '$lib/server/api/rate-limit';
import {
	extractBearer,
	hasScope,
	parseApiScopes,
	parseCursor,
	parseFilter,
	parseIdParam,
	parseLimitParam,
	scopesFromString,
	scopesToString
} from '$lib/server/api/validate';

describe('api validate helpers', () => {
	it('parses bearer headers case-insensitively', () => {
		expect(extractBearer('Bearer abc')).toBe('abc');
		expect(extractBearer('bearer  xyz  ')).toBe('xyz');
		expect(extractBearer(null)).toBeNull();
		expect(extractBearer('Basic abc')).toBeNull();
		expect(extractBearer('Bearer ')).toBeNull();
	});

	it('parses scopes and implies read from write', () => {
		expect(parseApiScopes(['write'])).toEqual(['read', 'write']);
		expect(parseApiScopes('read,write')).toEqual(['read', 'write']);
		expect(parseApiScopes([])).toBeNull();
		expect(parseApiScopes(['admin'])).toBeNull();
		expect(scopesToString(['write', 'read'])).toBe('read,write');
		expect(scopesFromString('read,write')).toEqual(['read', 'write']);
		expect(hasScope(['write'], 'read')).toBe(true);
		expect(hasScope(['read'], 'write')).toBe(false);
	});

	it('parses ids, limits, cursors, filters', () => {
		expect(parseIdParam('12')).toBe(12);
		expect(parseIdParam('0')).toBeNull();
		expect(parseIdParam('x')).toBeNull();
		expect(parseLimitParam('5')).toBe(5);
		expect(parseLimitParam('9999')).toBe(100);
		expect(parseLimitParam(null)).toBe(30);
		expect(parseCursor('7')).toBe(7);
		expect(parseCursor('')).toBeNull();
		expect(parseFilter('today')).toBe('today');
		expect(parseFilter('nope')).toBeNull();
	});
});

describe('api token format', () => {
	it('mints prefixed tokens with stable hashes', () => {
		const { plaintext, prefix } = mintPlaintext();
		expect(plaintext.startsWith(API_TOKEN_PREFIX)).toBe(true);
		expect(prefix.startsWith(API_TOKEN_PREFIX)).toBe(true);
		expect(hashApiToken(plaintext)).toBe(hashApiToken(plaintext));
		expect(hashApiToken(plaintext)).not.toBe(hashApiToken(plaintext + 'x'));
	});
});

describe('rate limiter', () => {
	it('allows up to the limit then blocks with retry-after', () => {
		_resetRateLimitsForTests();
		const now = 1_000_000;
		expect(checkRateLimit('k', 2, 60_000, now).allowed).toBe(true);
		expect(checkRateLimit('k', 2, 60_000, now).allowed).toBe(true);
		const blocked = checkRateLimit('k', 2, 60_000, now);
		expect(blocked.allowed).toBe(false);
		expect(blocked.retryAfterSec).toBeGreaterThan(0);
		expect(checkRateLimit('k', 2, 60_000, now + 61_000).allowed).toBe(true);
		_resetRateLimitsForTests();
	});
});
