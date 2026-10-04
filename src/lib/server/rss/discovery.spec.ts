import { describe, expect, it } from 'vitest';
import {
	includesPhrase,
	isUrlLike,
	rankCandidates,
	sortCandidates,
	tokenOverlap,
	type DiscoverCandidate,
	type DiscoveryContext
} from './discovery';

const ctx: DiscoveryContext = {
	tagNames: ['ai', 'programming'],
	feedTitles: ['Hacker News'],
	subscribedTargets: new Set(['/github/trending/daily']),
	subscribedHosts: new Set<string>(),
	mutedTopics: new Set(['crypto']),
	mutedRoutes: new Set()
};

function cand(patch: Partial<DiscoverCandidate> & { routePath: string }): DiscoverCandidate {
	return {
		id: patch.routePath,
		title: 'T',
		namespace: 'ns',
		domain: 'example.com',
		url: 'http://h/x',
		needsParams: false,
		score: 0,
		subscribed: false,
		muted: false,
		...patch
	};
}

describe('isUrlLike', () => {
	it('detects urls and bare domains', () => {
		expect(isUrlLike('https://example.com/blog')).toBe(true);
		expect(isUrlLike('youtube.com/@handle')).toBe(true);
		expect(isUrlLike('example.com')).toBe(true);
	});
	it('rejects keywords and spaced input', () => {
		expect(isUrlLike('machine learning')).toBe(false);
		expect(isUrlLike('ai security news')).toBe(false);
		expect(isUrlLike('')).toBe(false);
	});
});

describe('rankCandidates', () => {
	const base = [
		cand({ routePath: '/github/trending/daily', title: 'Trending', subscribed: true }),
		cand({ routePath: '/example/ai-security', title: 'AI security newsletter' }),
		cand({ routePath: '/example/crypto-news', title: 'Crypto daily' })
	];
	it('demotes subscribed rows below fresh ones', () => {
		const out = rankCandidates(base, 'trending', ctx);
		expect(out[out.length - 1].routePath).toBe('/github/trending/daily');
	});
	it('lifts tag-matching rows for interest queries', () => {
		const out = rankCandidates(base, 'ai', ctx);
		expect(out[0].routePath).toBe('/example/ai-security');
	});
	it('sorts az alphabetically', () => {
		const out = rankCandidates(base, 'x', ctx, 'az');
		expect(out.map((c) => c.title)).toStrictEqual([
			'AI security newsletter',
			'Crypto daily',
			'Trending'
		]);
	});
});

describe('sortCandidates', () => {
	it('keeps score order by default', () => {
		const rows = [cand({ routePath: '/a', score: 1 }), cand({ routePath: '/b', score: 5 })];
		expect(sortCandidates(rows, 'best')[0].routePath).toBe('/b');
	});
});

describe('tokenOverlap', () => {
	it('matches whole tokens and prefixes', () => {
		expect(tokenOverlap('ai security', 'AI security newsletter')).toBe(1);
		expect(tokenOverlap('sec', 'security newsletter')).toBe(1);
	});
	it('does not match inside unrelated words', () => {
		expect(tokenOverlap('ai', 'Crypto daily')).toBe(0);
		expect(tokenOverlap('ai', 'Trending daily')).toBe(0);
	});
	it('returns partial credit', () => {
		expect(tokenOverlap('ai crypto', 'AI security newsletter')).toBe(0.5);
	});
	it('returns 0 for blank input', () => {
		expect(tokenOverlap('', 'hello')).toBe(0);
		expect(tokenOverlap('ai', '')).toBe(0);
	});
});

describe('includesPhrase', () => {
	it('matches contiguous phrases on word boundaries', () => {
		expect(includesPhrase('AI security newsletter', 'ai security')).toBe(true);
		expect(includesPhrase('/github/trending/daily', 'trending')).toBe(true);
	});
	it('rejects substrings inside longer words', () => {
		expect(includesPhrase('/github/trending/daily', 'aily')).toBe(false);
		expect(includesPhrase('Trending daily', 'ai')).toBe(false);
	});
	it('matches CJK phrases without word spaces', () => {
		expect(includesPhrase('黄金科技大会', '科技')).toBe(true);
	});
});
