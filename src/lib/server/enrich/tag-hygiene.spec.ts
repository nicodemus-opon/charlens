import { describe, expect, it } from 'vitest';
import { bagKey, isJunkTag, isSameTag, singularize, singularKey } from './tag-hygiene';

describe('singularize', () => {
	it('handles plurals', () => {
		expect(singularize('incidents')).toBe('incident');
		expect(singularize('agents')).toBe('agent');
		expect(singularize('ai')).toBe('ai');
	});
});

describe('dup keys', () => {
	it('matches singular/plural dups', () => {
		expect(singularKey('Coding Agents')).toBe('coding agent');
		expect(isSameTag('coding agent', 'coding agents')).toBe(true);
	});

	it('matches word-order dups', () => {
		expect(bagKey('agent coding')).toBe(bagKey('coding agent'));
		expect(isSameTag('agent coding', 'coding agents')).toBe(true);
	});

	it('does not collapse distinct tags', () => {
		expect(isSameTag('nvidia', 'amd')).toBe(false);
		expect(isSameTag('ai infrastructure', 'cooking')).toBe(false);
	});
});

describe('isJunkTag', () => {
	it('flags exact junk', () => {
		expect(isJunkTag('page page')).toBe(true);
		expect(isJunkTag('flash sale')).toBe(true);
		expect(isJunkTag('incidents')).toBe(true);
		expect(isJunkTag('')).toBe(true);
	});

	it('flags time chrome and shards', () => {
		expect(isJunkTag('3 hrs ago')).toBe(true);
		expect(isJunkTag('kenya g')).toBe(true);
		expect(isJunkTag('sh26')).toBe(true);
	});

	it('flags repeated phrases and stutter', () => {
		expect(isJunkTag('page page')).toBe(true);
		expect(isJunkTag('claude code claude code')).toBe(true);
		expect(isJunkTag('microduck rl rl')).toBe(true);
	});

	it('flags generic singletons but keeps multi-word carriers', () => {
		expect(isJunkTag('model')).toBe(true);
		expect(isJunkTag('power')).toBe(true);
		// Multi-word tags that merely contain a generic/filler word are real
		// labels, not junk (seen on real data: "claude code" e4).
		expect(isJunkTag('power grid')).toBe(false);
		expect(isJunkTag('claude code')).toBe(false);
		expect(isJunkTag('coding agents')).toBe(false);
		expect(isJunkTag('enterprise resource planning')).toBe(false);
	});

	it('keeps real tags', () => {
		expect(isJunkTag('nvidia')).toBe(false);
		expect(isJunkTag('architecture & design')).toBe(false);
		expect(isJunkTag('menengai geothermal')).toBe(false);
	});
});
