import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireUser } from '$lib/server/guard';
import { getUserSettings, resetUserSettings, setUserSetting } from '$lib/server/settings';
import { isSettingKey, sanitizeSetting } from '$lib/settings.js';
import { OPML_MAX_BYTES, OpmlError, parseOpml } from '$lib/opml';
import { addFeed, populateFeed } from '$lib/server/rss/refresh';
import { db } from '$lib/server/db';
import { articleEvent, userFeedback, userSetting, userViewPref } from '$lib/server/db/feeds.schema';
import { feed } from '$lib/server/db/feeds.schema';
import { desc, eq } from 'drizzle-orm';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);
	let settings: Record<string, unknown> = {};
	try {
		settings = await getUserSettings(user.id);
	} catch (e) {
		console.error('settings load failed', e);
	}
	let feedback: {
		id: number;
		kind: string;
		articleId: number | null;
		feedId: number | null;
		feedTitle: string | null;
		topic: string | null;
		createdAt: Date;
	}[] = [];
	try {
		const rows = await db
			.select({
				id: userFeedback.id,
				kind: userFeedback.kind,
				articleId: userFeedback.articleId,
				feedId: userFeedback.feedId,
				topic: userFeedback.topic,
				createdAt: userFeedback.createdAt
			})
			.from(userFeedback)
			.where(eq(userFeedback.userId, user.id))
			.orderBy(desc(userFeedback.createdAt))
			.limit(100);
		const feeds = await db
			.select({ id: feed.id, title: feed.title })
			.from(feed)
			.where(eq(feed.userId, user.id));
		const titles = new Map(feeds.map((f) => [f.id, f.title]));
		feedback = rows.map((r) => ({
			...r,
			feedTitle: r.feedId != null ? (titles.get(r.feedId) ?? `Feed ${r.feedId}`) : null
		}));
	} catch (e) {
		console.error('feedback load failed', e);
	}
	return { settings, feedback };
};

export const actions: Actions = {
	saveSetting: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const keyRaw = String(form.get('key') ?? '').trim();
		const valueRaw = String(form.get('value') ?? '');
		if (!isSettingKey(keyRaw)) return fail(400, { message: 'Unknown setting' });
		let parsed: unknown = valueRaw;
		try {
			parsed = JSON.parse(valueRaw);
		} catch {
			// Keep raw string (e.g. plain enum from non-JS posts).
		}
		const clean = sanitizeSetting(keyRaw, parsed);
		if (clean === null) return fail(400, { message: 'Invalid value' });
		try {
			await setUserSetting(user.id, keyRaw, clean);
		} catch (e) {
			console.error('saveSetting failed', e);
			return fail(500, { message: 'Could not save setting' });
		}
		return { ok: true, key: keyRaw, value: clean };
	},
	resetSettings: async ({ locals }) => {
		const user = requireUser(locals);
		try {
			await resetUserSettings(user.id);
		} catch (e) {
			console.error('resetSettings failed', e);
			return fail(500, { message: 'Could not reset settings' });
		}
		return { ok: true };
	},
	importOpml: async ({ request, locals, platform }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const file = form.get('file');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { message: 'Choose an OPML file to import.' });
		}
		if (file.size > OPML_MAX_BYTES) {
			return fail(400, { message: 'File too large (max 2 MB).' });
		}
		let text: string;
		try {
			text = await file.text();
		} catch (e) {
			console.error('importOpml read failed', e);
			return fail(400, { message: 'Could not read that file.' });
		}
		let entries;
		try {
			entries = parseOpml(text);
		} catch (e) {
			const message = e instanceof OpmlError ? e.message : 'Could not parse that OPML file.';
			return fail(400, { message });
		}
		let added = 0;
		let skipped = 0;
		for (const entry of entries) {
			try {
				new URL(entry.url);
			} catch {
				skipped += 1;
				continue;
			}
			try {
				// Fast path (same as the add-feed form): insert + subscribe only.
				// Discovery/fetch runs after the response so large imports
				// don't time out the action.
				const feedId = await addFeed(user.id, entry.url, entry.collection);
				added += 1;
				const background = populateFeed(feedId, entry.url);
				(
					platform as { context?: { waitUntil?: (p: Promise<unknown>) => void } } | undefined
				)?.context?.waitUntil?.(background);
			} catch (e) {
				console.error('importOpml feed failed', entry.url, e);
				skipped += 1;
			}
		}
		return { ok: true, added, skipped };
	},
	resetScopes: async ({ locals }) => {
		const user = requireUser(locals);
		try {
			await db.delete(userViewPref).where(eq(userViewPref.userId, user.id));
			await db.delete(userSetting).where(eq(userSetting.userId, user.id));
		} catch (e) {
			console.error('resetScopes failed', e);
			return fail(500, { message: 'Could not reset layouts' });
		}
		return { ok: true };
	},
	resetRecommended: async ({ locals }) => {
		const user = requireUser(locals);
		try {
			await db.delete(userFeedback).where(eq(userFeedback.userId, user.id));
			await db.delete(articleEvent).where(eq(articleEvent.userId, user.id));
		} catch (e) {
			console.error('resetRecommended failed', e);
			return fail(500, { message: 'Could not reset recommendations' });
		}
		return { ok: true };
	},
	removeFeedback: async ({ request, locals }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isFinite(id)) return fail(400, { message: 'Invalid feedback' });
		try {
			const rows = await db
				.select({ id: userFeedback.id })
				.from(userFeedback)
				.where(eq(userFeedback.userId, user.id));
			if (!rows.some((r) => r.id === id)) return fail(404, { message: 'Not found' });
			await db.delete(userFeedback).where(eq(userFeedback.id, id));
		} catch (e) {
			console.error('removeFeedback failed', e);
			return fail(500, { message: 'Could not remove' });
		}
		return { ok: true };
	}
};
