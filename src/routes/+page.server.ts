import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireUser } from '$lib/server/guard';
import { parseSmartRules } from '$lib/collections';
import { getViewScopeKey } from '$lib/view-prefs';
import { getViewPrefs, isArticleView, setViewPref } from '$lib/server/view-prefs';
import { getUserSettings } from '$lib/server/settings';
import {
	addFeed,
	createCollection,
	createSmartCollection,
	deleteCollection,
	deleteTag,
	getArticleById,
	getArticles,
	getArticleTags,
	getRecommendedArticles,
	getSmartRules,
	getTagsForArticles,
	listTags,
	logArticleEvent,
	markRead,
	markScopeRead,
	moveFeed,
	populateFeed,
	refreshStaleFeeds,
	renameCollection,
	renameTag,
	setArticleTags,
	toggleRead,
	toggleSaved,
	unsubscribe,
	type ArticleFilter
} from '$lib/server/rss/refresh';

const FILTERS: ArticleFilter[] = ['today', 'saved', 'all', 'recommended'];

/**
 * Redirect back to the page that posted (not the `?/action` URL): enhanced
 * forms POST to the action URL, so `url` carries `?/toggleSaved`-style params
 * and redirecting to it mangles the address bar and drops the filter. The
 * Referer is the rendered page in both fetch and classic posts; fall back to
 * the action URL path when it's missing or cross-origin.
 */
function redirectBack(url: URL, request: Request): never {
	const referer = request.headers.get('referer');
	if (referer) {
		try {
			const back = new URL(referer);
			if (back.origin === url.origin) {
				throw redirect(303, `${back.pathname}${back.search}`);
			}
		} catch (e) {
			if (e && typeof e === 'object' && 'status' in e) throw e;
		}
	}
	throw redirect(303, `${url.pathname}?${url.searchParams.toString()}`);
}

export const load: PageServerLoad = async ({ url, locals }) => {
	const user = requireUser(locals);
	const rawFilter = url.searchParams.get('filter') ?? 'today';
	const filter: ArticleFilter = FILTERS.includes(rawFilter as ArticleFilter)
		? (rawFilter as ArticleFilter)
		: 'today';
	const feedParam = url.searchParams.get('feed');
	const feedId = feedParam ? Number(feedParam) : undefined;
	const collectionParam = url.searchParams.get('collection');
	const collectionId = collectionParam ? Number(collectionParam) : undefined;
	const viewParam = url.searchParams.get('view');
	const viewId = viewParam ? Number(viewParam) : undefined;
	const tagParam = url.searchParams.get('tag');
	const tagId = tagParam ? Number(tagParam) : undefined;
	const query = url.searchParams.get('q') ?? '';
	const articleId = url.searchParams.get('article');
	const shuffleSeed = url.searchParams.get('shuffle') ?? '';
	const deepShuffle = url.searchParams.get('deep') === '1';

	try {
		// Best-effort background refresh: never block page render on network
		// I/O. A hanging feed fetch used to stall navigation (apparent UI
		// freeze on filter switches); fresh items land on the next load.
		// The explicit Refresh button still awaits completion.
		// Scoped views (feed/tag/collection/smart) never trigger it: firing
		// a network storm on every scope click steals CPU/DB from the page
		// load itself on small hosts.
		if (!articleId && !feedId && !collectionId && !viewId && !tagId && !query) {
			void refreshStaleFeeds(user.id, false).catch((e) =>
				console.error('background refresh failed', e)
			);
		}
		// A smart view resolves its rules at read time (dynamic article list).
		const smart = Number.isFinite(viewId) ? await getSmartRules(user.id, viewId!) : null;
		// Search "just works": any query outside a collection/tag/smart scope is
		// ranked semantically by getRecommendedArticles (falls back to keyword
		// matching automatically when the embedding model is unavailable).
		const useRecommended =
			!collectionId && !tagId && !smart && (filter === 'recommended' || query.trim() !== '');
		const articles = useRecommended
			? await getRecommendedArticles(user.id, {
					feedId: Number.isFinite(feedId) ? feedId : undefined,
					query,
					limit: 100,
					seed: shuffleSeed,
					deep: deepShuffle
				})
			: await getArticles(user.id, {
					feedId: Number.isFinite(feedId) ? feedId : undefined,
					collectionId: Number.isFinite(collectionId) ? collectionId : undefined,
					tagId: Number.isFinite(tagId) ? tagId : undefined,
					smart: smart ?? undefined,
					filter: filter === 'recommended' ? 'all' : filter,
					query,
					limit: 100
				});
		// Everything below fans out in parallel: the old sequential chain
		// (~7 round trips) was the main cost of tag/scope clicks on
		// higher-latency databases. selectedId is known up front, so even
		// the selection detail + its tags join the same block.
		const selectedId = articleId ? Number(articleId) : articles[0]?.id;
		const [tagMap, selected, settingsResult, tags, viewPrefs, selectedTags] = await Promise.all([
			getTagsForArticles(
				user.id,
				articles.map((a) => a.id)
			),
			selectedId ? getArticleById(user.id, selectedId) : Promise.resolve(null),
			getUserSettings(user.id).catch((e) => {
				console.error('settings load failed', e);
				return {};
			}),
			listTags(user.id),
			getViewPrefs(user.id).catch((e) => {
				console.error('view prefs load failed', e);
				return {};
			}),
			selectedId ? getArticleTags(user.id, selectedId) : Promise.resolve([])
		]);
		const articlesWithTags = articles.map((a) => ({ ...a, tags: tagMap.get(a.id) ?? [] }));
		// Account settings gate auto-read + telemetry (Settings → reading &
		// Account settings gate auto-read + telemetry (Settings → reading &
		// privacy). Pre-migration DBs fall back to the historical always-on.
		const settings = settingsResult as Record<string, unknown>;
		const markReadOnOpen =
			typeof settings.markReadOnOpen === 'boolean' ? settings.markReadOnOpen : true;
		const telemetryEnabled =
			typeof settings.telemetryEnabled === 'boolean' ? settings.telemetryEnabled : true;
		const writes: Promise<unknown>[] = [];
		if (selected && !selected.isRead && markReadOnOpen) {
			writes.push(markRead(user.id, selected.id, true));
			selected.isRead = true;
		}
		if (selected && articleId && telemetryEnabled) {
			writes.push(logArticleEvent(user.id, selected.id, 'open'));
		}
		if (writes.length > 0) await Promise.all(writes);
		const viewScope = getViewScopeKey({
			filter,
			feedId,
			collectionId,
			viewId,
			tagId,
			query
		});
		return {
			articles: articlesWithTags,
			selected: selected ? { ...selected, tags: selectedTags } : null,
			tags,
			filter,
			feedId: feedId ?? null,
			collectionId: collectionId ?? null,
			viewId: viewId ?? null,
			tagId: tagId ?? null,
			query,
			viewPrefs,
			viewScope
		};
	} catch (e) {
		console.error('feed load failed (db down?)', e);
		return {
			articles: [],
			selected: null,
			tags: [],
			filter,
			feedId: null,
			collectionId: null,
			viewId: null,
			tagId: null,
			query,
			viewPrefs: {},
			viewScope: getViewScopeKey({ filter }),
			dbDown: true
		};
	}
};

export const actions: Actions = {
	addFeed: async ({ request, locals, platform }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const url = String(form.get('url') ?? '').trim();
		// The add form posts `collection` (name or id); fall back to the
		// legacy `category` field from older clients.
		const collectionRaw = form.get('collection') ?? form.get('category') ?? 'General';
		const collectionRef =
			typeof collectionRaw === 'string' && /^\d+$/.test(collectionRaw.trim())
				? Number(collectionRaw)
				: String(collectionRaw).trim() || 'General';
		if (!url) return fail(400, { message: 'URL is required' });
		try {
			new URL(url);
		} catch {
			return fail(400, { message: 'Enter a valid URL.' });
		}
		let feedId: number;
		try {
			// Fast path: insert + subscribe only. Scraping/parsing runs after the
			// response so the dialog closes immediately.
			feedId = await addFeed(user.id, url, collectionRef);
		} catch (e) {
			console.error('addFeed failed', e);
			return fail(400, {
				message: 'Could not add feed.'
			});
		}
		const background = populateFeed(feedId, url);
		// On serverless platforms keep the work alive past the response;
		// elsewhere the unawaited promise just runs (populateFeed never throws).
		(
			platform as { context?: { waitUntil?: (p: Promise<unknown>) => void } } | undefined
		)?.context?.waitUntil?.(background);
		throw redirect(303, '/?filter=all');
	},
	refresh: async ({ locals }) => {
		const user = requireUser(locals);
		try {
			await refreshStaleFeeds(user.id, true);
		} catch (e) {
			console.error('refresh failed', e);
			return fail(500, { message: 'Refresh failed' });
		}
	},
	markRead: async ({ request, url, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (Number.isFinite(id)) await markRead(user.id, id, true);
		redirectBack(url, request);
	},
	markAllRead: async ({ url, locals }) => {
		const user = requireUser(locals);
		// Scope mirrors `load`: the bulk mark covers exactly the rendered list
		// (recommended/query ranking resolved server-side — see markScopeRead).
		const rawFilter = url.searchParams.get('filter') ?? 'today';
		const filter: ArticleFilter = FILTERS.includes(rawFilter as ArticleFilter)
			? (rawFilter as ArticleFilter)
			: 'today';
		const feedParam = url.searchParams.get('feed');
		const feedId = feedParam ? Number(feedParam) : undefined;
		const collectionParam = url.searchParams.get('collection');
		const collectionId = collectionParam ? Number(collectionParam) : undefined;
		const viewParam = url.searchParams.get('view');
		const viewId = viewParam ? Number(viewParam) : undefined;
		const tagParam = url.searchParams.get('tag');
		const tagId = tagParam ? Number(tagParam) : undefined;
		const query = url.searchParams.get('q') ?? '';
		try {
			const smart = Number.isFinite(viewId) ? await getSmartRules(user.id, viewId!) : null;
			const { marked } = await markScopeRead(user.id, {
				feedId: Number.isFinite(feedId) ? feedId : undefined,
				collectionId: Number.isFinite(collectionId) ? collectionId : undefined,
				tagId: Number.isFinite(tagId) ? tagId : undefined,
				smart: smart ?? undefined,
				filter,
				query,
				limit: 100
			});
			return { marked };
		} catch (e) {
			console.error('markAllRead failed', e);
			return fail(500, { message: 'Could not mark all as read' });
		}
	},
	toggleRead: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isFinite(id)) return fail(400, { message: 'Invalid article' });
		// Return (don't redirect): the keyboard caller reads the new state to
		// decide whether to move selection — the loader auto-marks whatever is
		// displayed, so staying put would instantly undo an unread toggle.
		const isRead = await toggleRead(user.id, id);
		return { isRead };
	},
	createCollection: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { message: 'Collection name is required' });
		try {
			await createCollection(user.id, name);
		} catch (e) {
			console.error('createCollection failed', e);
			return fail(400, { message: 'Could not create collection' });
		}
		throw redirect(303, '/?filter=all');
	},
	renameCollection: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const id = Number(form.get('id'));
		const name = String(form.get('name') ?? '').trim();
		if (!Number.isFinite(id) || !name) return fail(400, { message: 'Invalid rename' });
		try {
			await renameCollection(user.id, id, name);
		} catch (e) {
			console.error('renameCollection failed', e);
			return fail(400, { message: 'Could not rename collection' });
		}
		throw redirect(303, '/?filter=all');
	},
	deleteCollection: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isFinite(id)) return fail(400, { message: 'Invalid collection' });
		try {
			await deleteCollection(user.id, id);
		} catch (e) {
			console.error('deleteCollection failed', e);
			return fail(400, {
				message: e instanceof Error ? e.message : 'Could not delete collection'
			});
		}
		throw redirect(303, '/?filter=all');
	},
	moveFeed: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const feedId = Number(form.get('feedId'));
		const collectionId = Number(form.get('collectionId'));
		if (!Number.isFinite(feedId) || !Number.isFinite(collectionId)) {
			return fail(400, { message: 'Invalid move' });
		}
		try {
			await moveFeed(user.id, feedId, collectionId);
		} catch (e) {
			console.error('moveFeed failed', e);
			return fail(400, { message: 'Could not move feed' });
		}
		throw redirect(303, '/?filter=all');
	},
	removeFeed: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const feedId = Number(form.get('feedId') ?? form.get('id'));
		if (!Number.isFinite(feedId)) return fail(400, { message: 'Invalid feed' });
		try {
			// Deletes the user's feed row; articles cascade via FK.
			await unsubscribe(user.id, feedId);
		} catch (e) {
			console.error('removeFeed failed', e);
			return fail(400, { message: 'Could not remove feed' });
		}
		throw redirect(303, '/?filter=all');
	},
	createSmartView: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (!name) return fail(400, { message: 'Smart view name is required' });
		// Rules arrive as individual fields from the builder dialog.
		const feedIds = String(form.get('feedIds') ?? '')
			.split(',')
			.map(Number)
			.filter((n) => Number.isInteger(n) && n > 0);
		const rules = parseSmartRules({
			match: String(form.get('match') ?? 'all'),
			keywords: String(form.get('keywords') ?? ''),
			author: String(form.get('author') ?? ''),
			feedIds,
			tags: String(form.get('tags') ?? ''),
			unreadOnly: form.get('unreadOnly') === 'on',
			savedOnly: form.get('savedOnly') === 'on',
			daysBack: form.get('daysBack') ? Number(form.get('daysBack')) : undefined
		});
		if (!rules) return fail(400, { message: 'Add at least one rule.' });
		try {
			const id = await createSmartCollection(user.id, name, rules);
			throw redirect(303, `/?view=${id}`);
		} catch (e) {
			if (e && typeof e === 'object' && 'status' in e) throw e;
			console.error('createSmartView failed', e);
			return fail(400, {
				message: e instanceof Error ? e.message : 'Could not create smart view'
			});
		}
	},
	toggleSaved: async ({ request, url, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (Number.isFinite(id)) await toggleSaved(user.id, id);
		redirectBack(url, request);
	},
	feedback: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const id = Number(form.get('id'));
		const kind = String(form.get('kind') ?? '');
		if (!Number.isFinite(id)) return fail(400, { message: 'Invalid article' });
		if (kind !== 'dismiss' && kind !== 'mute_feed' && kind !== 'mute_topic') {
			return fail(400, { message: 'Invalid feedback' });
		}
		try {
			// logArticleEvent persists the event + structured user_feedback row
			// (hard filters + negative affinity) and refreshes the interest
			// model in the background. Returns ok (no redirect) so the caller
			// revalidates in place — the list drops the dismissed story.
			await logArticleEvent(user.id, id, kind);
		} catch (e) {
			console.error('feedback failed', e);
			return fail(500, { message: 'Could not save feedback' });
		}
		return { ok: true };
	},
	setArticleTags: async ({ request, url, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const id = Number(form.get('id'));
		const tags = String(form.get('tags') ?? '');
		if (Number.isFinite(id)) await setArticleTags(user.id, id, tags);
		throw redirect(303, `${url.pathname}?${url.searchParams.toString()}`);
	},
	renameTag: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const id = Number(form.get('id'));
		const name = String(form.get('name') ?? '').trim();
		if (!Number.isFinite(id) || !name) return fail(400, { message: 'Invalid tag rename' });
		try {
			await renameTag(user.id, id, name);
		} catch (e) {
			console.error('renameTag failed', e);
			return fail(400, { message: 'Could not rename tag' });
		}
		throw redirect(303, '/?filter=all');
	},
	deleteTag: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isFinite(id)) return fail(400, { message: 'Invalid tag' });
		try {
			await deleteTag(user.id, id);
		} catch (e) {
			console.error('deleteTag failed', e);
			return fail(400, { message: 'Could not delete tag' });
		}
		throw redirect(303, '/?filter=all');
	},
	setViewPref: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const scope = String(form.get('scope') ?? '').trim();
		const view = String(form.get('view') ?? '').trim();
		if (!scope || !isArticleView(view)) return fail(400, { message: 'Invalid view pref' });
		try {
			await setViewPref(user.id, scope, view);
		} catch (e) {
			console.error('setViewPref failed', e);
			return fail(500, { message: 'Could not save view' });
		}
		return { ok: true };
	}
};
