import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { SIDEBAR_COOKIE_NAME } from '$lib/components/ui/sidebar/constants.js';
import {
	getFeedsWithCounts,
	getRecommendedCount,
	listCollections,
	listTags
} from '$lib/server/rss/refresh';

export const load: LayoutServerLoad = async ({ locals, cookies, route }) => {
	const user = locals.user
		? {
				id: locals.user.id,
				name: locals.user.name,
				email: locals.user.email,
				avatar: locals.user.image ?? null
			}
		: null;

	// Self-hosted multi-user: every page except /login requires a session.
	if (!user && route.id !== '/login') redirect(302, '/login');

	// The sidebar provider writes this cookie on every toggle; read it back so the
	// collapsed (icon rail) state survives reloads.
	const sidebarOpen = cookies.get(SIDEBAR_COOKIE_NAME) !== 'false';

	if (!user)
		return {
			feeds: [],
			collections: [],
			tags: [],
			counts: { today: 0, recommended: 0 },
			user,
			sidebarOpen
		};

	try {
		const [feeds, collections, tags, recommended] = await Promise.all([
			getFeedsWithCounts(user.id),
			listCollections(user.id),
			listTags(user.id),
			getRecommendedCount(user.id)
		]);
		const todayUnread = feeds.reduce((n, f) => n + (f.unread ?? 0), 0);
		return {
			feeds,
			collections,
			tags,
			counts: { today: todayUnread, recommended },
			user,
			sidebarOpen
		};
	} catch {
		return {
			feeds: [],
			collections: [],
			tags: [],
			counts: { today: 0, recommended: 0 },
			user,
			sidebarOpen
		};
	}
};
