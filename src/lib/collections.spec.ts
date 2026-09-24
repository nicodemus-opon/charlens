import { describe, expect, it } from 'vitest';
import {
	GENERAL_COLLECTION,
	normalizeCollectionName,
	normalizeSmartRules,
	parseSmartRules,
	validateSmartRules
} from './collections';

describe('normalizeCollectionName', () => {
	it('trims whitespace', () => {
		expect(normalizeCollectionName('  Dev  ')).toBe('Dev');
	});

	it('caps length at 60 chars', () => {
		expect(normalizeCollectionName('x'.repeat(100))).toHaveLength(60);
	});
});

describe('validateSmartRules', () => {
	it('rejects empty rules', () => {
		expect(validateSmartRules({})).toMatch(/at least one rule/);
	});

	it('accepts a single keyword', () => {
		expect(validateSmartRules({ keywords: ['launch'] })).toBeNull();
	});

	it('treats blank keywords as empty', () => {
		expect(validateSmartRules({ keywords: ['  '] })).toMatch(/at least one rule/);
	});

	it('accepts unread-only', () => {
		expect(validateSmartRules({ unreadOnly: true })).toBeNull();
	});
});

describe('normalizeSmartRules', () => {
	it('dedupes keywords and drops blanks', () => {
		expect(normalizeSmartRules({ keywords: ['a', ' a ', ''] }).keywords).toEqual(['a']);
	});

	it('drops non-positive feed ids', () => {
		expect(normalizeSmartRules({ feedIds: [0, -1, 3] }).feedIds).toEqual([3]);
	});

	it('clamps daysBack', () => {
		expect(normalizeSmartRules({ daysBack: 0 }).daysBack).toBeUndefined();
		expect(normalizeSmartRules({ daysBack: 7 }).daysBack).toBe(7);
	});

	it('defaults match to all', () => {
		expect(normalizeSmartRules({ keywords: ['x'] }).match).toBe('all');
		expect(normalizeSmartRules({ match: 'any', keywords: ['x'] }).match).toBe('any');
	});
});

describe('parseSmartRules', () => {
	it('parses comma-separated keyword strings from forms', () => {
		const rules = parseSmartRules({ keywords: 'launch, funding ' });
		expect(rules?.keywords).toEqual(['launch', 'funding']);
	});

	it('parses feed id strings', () => {
		const rules = parseSmartRules({ feedIds: '1,2,x' });
		expect(rules?.feedIds).toEqual([1, 2]);
	});

	it('returns null for non-objects', () => {
		expect(parseSmartRules(null)).toBeNull();
		expect(parseSmartRules('x')).toBeNull();
		expect(parseSmartRules([])).toBeNull();
	});

	it('keeps the General fallback name constant', () => {
		expect(GENERAL_COLLECTION).toBe('General');
	});
});
