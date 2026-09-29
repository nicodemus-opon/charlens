import { describe, expect, it } from 'vitest';
import { defaultViewForScope, getViewScopeKey, resolveView } from './view-prefs';
import type { ArticleView } from './article';

function isArticleView(value: unknown): value is ArticleView {
	return value === 'list' || value === 'grid' || value === 'compact' || value === 'magazine';
}

describe('getViewScopeKey', () => {
	it('keys the three default-magazine filters separately', () => {
		expect(getViewScopeKey({ filter: 'today' })).toBe('filter:today');
		expect(getViewScopeKey({ filter: 'saved' })).toBe('filter:saved');
		expect(getViewScopeKey({ filter: 'recommended' })).toBe('filter:recommended');
	});

	it('prefers the most-specific scope', () => {
		expect(getViewScopeKey({ filter: 'all', collectionId: 12 })).toBe('collection:12');
		expect(getViewScopeKey({ filter: 'all', viewId: 5 })).toBe('view:5');
		expect(getViewScopeKey({ filter: 'all', feedId: 7 })).toBe('feed:7');
		expect(getViewScopeKey({ filter: 'all', tagId: 3 })).toBe('tag:3');
		expect(getViewScopeKey({ filter: 'all', query: 'svelte' })).toBe('search');
		expect(getViewScopeKey({ filter: 'all', collectionId: 12, feedId: 7, query: 'svelte' })).toBe(
			'collection:12'
		);
	});

	it('falls back to the filter for bare scopes', () => {
		expect(getViewScopeKey({})).toBe('filter:today');
		expect(getViewScopeKey({ filter: 'all' })).toBe('filter:all');
	});
});

describe('defaultViewForScope', () => {
	it('defaults Today / Read later / Recommended to magazine', () => {
		expect(defaultViewForScope('filter:today')).toBe('magazine');
		expect(defaultViewForScope('filter:saved')).toBe('magazine');
		expect(defaultViewForScope('filter:recommended')).toBe('magazine');
	});

	it('defaults everything else to list', () => {
		expect(defaultViewForScope('filter:all')).toBe('list');
		expect(defaultViewForScope('collection:1')).toBe('list');
		expect(defaultViewForScope('view:1')).toBe('list');
		expect(defaultViewForScope('search')).toBe('list');
	});
});

describe('resolveView', () => {
	it('prefers the saved pref over the default', () => {
		expect(resolveView({ 'filter:today': 'list' }, 'filter:today', isArticleView)).toBe('list');
		expect(resolveView({}, 'filter:today', isArticleView)).toBe('magazine');
		expect(resolveView({}, 'collection:9', isArticleView)).toBe('list');
	});
});
