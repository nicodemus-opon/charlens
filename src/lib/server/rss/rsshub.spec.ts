import { describe, expect, it } from 'vitest';
import {
	_resetRadarCache,
	buildRsshubUrl,
	extractPrefill,
	isRsshubUrl,
	matchRadarRules,
	matchSourcePattern,
	resolveCandidateUrl
} from './rsshub';

describe('buildRsshubUrl', () => {
	it('pins format=rss with fulltext defaults', () => {
		const url = buildRsshubUrl('/github/trending/daily/javascript');
		expect(url).toContain('format=rss');
		expect(url).toContain('mode=fulltext');
		expect(url).toContain('limit=50');
	});

	it('rejects path traversal', () => {
		expect(() => buildRsshubUrl('/../etc/passwd')).toThrow();
		expect(() => buildRsshubUrl('/a//b')).toThrow();
	});

	it('drops disallowed params and keeps allowlisted ones', () => {
		const url = buildRsshubUrl('/x/y', { limit: 10, filter: 'a', evil: '1' } as never);
		expect(url).toContain('limit=10');
		expect(url).toContain('filter=a');
		expect(url).not.toContain('evil');
	});
});

describe('isRsshubUrl', () => {
	it('detects instance host', () => {
		expect(isRsshubUrl('http://localhost:1200/rsshub/test?format=rss')).toBe(true);
		expect(isRsshubUrl('https://example.com/feed')).toBe(false);
	});
});

describe('matchRadarRules', () => {
	it('matches domain-keyed rules to a site url', () => {
		_resetRadarCache();
		const rules = {
			'example.com': {
				'.': [{ title: 'Example blog', source: ['/'], target: '/example/blog' }]
			}
		};
		const out = matchRadarRules(rules, 'https://example.com/');
		expect(out.length).toBe(1);
		expect(out[0].routePath).toBe('/example/blog');
		expect(out[0].url).toContain('format=rss');
	});

	it('returns empty for unknown hosts', () => {
		const out = matchRadarRules({ 'other.com': {} }, 'https://unknown.example/');
		expect(out).toStrictEqual([]);
	});

	it('flags templated targets needing params', () => {
		const rules = {
			'telegram.me': [{ title: 'Channel', source: ['/'], target: '/telegram/channel/:username' }]
		};
		const out = matchRadarRules(rules, 'https://telegram.me/');
		expect(out.length).toBe(1);
		expect(out[0].needsParams).toBe(true);
		// Not subscribable as-is: no fake one-click URL.
		expect(out[0].url).toBe('');
	});

	it('keeps docs links on the theverge-style template', () => {
		const rules = {
			'theverge.com': {
				_name: 'The Verge',
				'.': [
					{
						title: 'Category',
						docs: 'https://docs.rsshub.app/routes/new-media',
						source: ['/:hub', '/'],
						target: '/theverge/:hub?'
					}
				]
			}
		};
		const out = matchRadarRules(rules, 'https://www.theverge.com/');
		expect(out.length).toBe(1);
		expect(out[0].routePath).toBe('/theverge/:hub?');
		expect(out[0].url).toBe('');
		expect(out[0].docs).toBe('https://docs.rsshub.app/routes/new-media');
	});

	it('sorts subscribable routes before templates', () => {
		const rules = {
			'site.test': {
				a: [{ title: 'Param', source: ['/'], target: '/site/:id' }],
				b: [{ title: 'Direct', source: ['/'], target: '/site/feed' }]
			}
		};
		const out = matchRadarRules(rules, 'https://site.test/');
		expect(out.length).toBe(2);
		expect(out[0].needsParams).toBe(false);
		expect(out[0].url).toContain('format=rss');
		expect(out[1].needsParams).toBe(true);
	});

	it('matches parameterized roots like the live radar payload', () => {
		const rules = {
			'163.com': {
				_name: '163',
				'vip.open': [{ title: 'VIP', source: ['/'], target: '/163/open/vip' }],
				renjian: [
					{ title: 'Renjian', source: ['/:category', '/'], target: '/163/renjian/:category?' }
				]
			}
		};
		const out = matchRadarRules(rules, 'https://163.com/');
		expect(out.length).toBe(2);
	});

	it('returns empty for garbage input', () => {
		expect(matchRadarRules(null, 'not a url [[[')).toStrictEqual([]);
	});
});

describe('matchSourcePattern', () => {
	it('captures a handle segment', () => {
		expect(matchSourcePattern('/:username', '/@ColeooyChess')).toStrictEqual({
			username: '@ColeooyChess'
		});
	});

	it('rejects static mismatches and extra segments', () => {
		expect(matchSourcePattern('/user/:username', '/@ColeooyChess')).toBeNull();
		expect(matchSourcePattern('/:username', '/a/b')).toBeNull();
		expect(matchSourcePattern('/channel/:id', '/channel/UC123')).toStrictEqual({ id: 'UC123' });
	});

	it('matches optional segments against the root without captures', () => {
		expect(matchSourcePattern('/:category?', '/')).toStrictEqual({});
	});
});

describe('extractPrefill', () => {
	const youtubeSources = ['/user/:username', '/:username', '/:username/videos'];

	it('maps by name from the matching source pattern', () => {
		expect(
			extractPrefill(youtubeSources, '/youtube/user/:username', '/@ColeooyChess')
		).toStrictEqual({ username: '@ColeooyChess' });
	});

	it('picks the pattern that actually matches', () => {
		expect(
			extractPrefill(youtubeSources, '/youtube/user/:username', '/@ColeooyChess/videos')
		).toStrictEqual({ username: '@ColeooyChess' });
	});

	it('falls back by position when names differ', () => {
		expect(extractPrefill(['/foo/:a'], '/bar/:b', '/foo/123')).toStrictEqual({ b: '123' });
	});

	it('returns null when nothing matches strictly', () => {
		expect(extractPrefill(youtubeSources, '/youtube/user/:username', '/')).toBeNull();
		expect(extractPrefill(['/feed/subscriptions'], '/youtube/subscriptions', '/')).toBeNull();
	});
});

describe('youtube handle end to end', () => {
	const rules = {
		'youtube.com': {
			_name: 'YouTube',
			www: [
				{
					title: 'Channel with user handle',
					docs: 'https://docs.rsshub.app/routes/social-media',
					source: ['/user/:username', '/:username', '/:username/videos'],
					target: '/youtube/user/:username'
				}
			]
		}
	};

	it('prefills username from the pasted handle url', () => {
		const out = matchRadarRules(rules, 'https://www.youtube.com/@ColeooyChess');
		expect(out.length).toBe(1);
		expect(out[0].routePath).toBe('/youtube/user/:username');
		expect(out[0].prefill).toStrictEqual({ username: '@ColeooyChess' });
		expect(resolveCandidateUrl(out[0])).toContain('/youtube/user/@ColeooyChess');
	});
});

describe('resolveCandidateUrl', () => {
	it('passes direct routes through', () => {
		expect(
			resolveCandidateUrl({ routePath: '/x/y', url: 'http://h/x/y?format=rss', prefill: undefined })
		).toBe('http://h/x/y?format=rss');
	});

	it('returns null when required params are missing', () => {
		expect(
			resolveCandidateUrl({ routePath: '/youtube/user/:username', url: '', prefill: undefined })
		).toBeNull();
	});

	it('resolves optional-only templates without values', () => {
		const url = resolveCandidateUrl({ routePath: '/theverge/:hub?', url: '', prefill: {} });
		expect(url).toContain('/theverge/');
		expect(url).toContain('format=rss');
	});
});
