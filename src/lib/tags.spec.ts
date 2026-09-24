import { describe, expect, it } from 'vitest';
import { normalizeFeedTags, normalizeTagName, parseTagInput, validateTagName } from './tags';

describe('normalizeTagName', () => {
	it('trims and collapses whitespace', () => {
		expect(normalizeTagName('  AI   News  ')).toBe('AI News');
	});

	it('caps length at 60 chars', () => {
		expect(normalizeTagName('x'.repeat(100))).toHaveLength(60);
	});
});

describe('parseTagInput', () => {
	it('splits commas and lowercases', () => {
		expect(parseTagInput('AI,  News ,ai')).toEqual(['ai', 'news']);
	});

	it('drops blanks', () => {
		expect(parseTagInput(' , ,')).toEqual([]);
	});
});

describe('normalizeFeedTags', () => {
	it('cleans category strings', () => {
		expect(normalizeFeedTags(['Tech', ' tech ', ''])).toEqual(['tech']);
	});

	it('returns empty for non-arrays', () => {
		expect(normalizeFeedTags(undefined)).toEqual([]);
		expect(normalizeFeedTags('x')).toEqual([]);
	});

	it('drops url shards, time chrome and blocklisted fragments', () => {
		expect(
			normalizeFeedTags([
				'http',
				'81rc.mil.cn',
				'https://example.com/feed',
				'3 hrs ago',
				'page',
				'123',
				'Architecture & Design',
				'ai, ml & data engineering'
			])
		).toEqual(['architecture & design', 'ai, ml & data engineering']);
	});
});

describe('validateTagName', () => {
	it('rejects blanks', () => {
		expect(validateTagName('   ')).toMatch(/required/);
	});

	it('accepts names', () => {
		expect(validateTagName('ai')).toBeNull();
	});
});
