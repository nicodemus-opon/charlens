import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { startScheduler } from '$lib/server/rss/scheduler';

// Background fetch: one interval per server process refreshes every stale
// feed across all users (per-user reads still use refreshStaleFeeds on load).
// Guarded against HMR double-starts via the globalThis singleton inside.
if (!building) {
	try {
		startScheduler();
	} catch (e) {
		console.error('feed scheduler failed to start', e);
	}
}

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	try {
		const session = await auth.api.getSession({ headers: event.request.headers });

		if (session) {
			event.locals.session = session.session;
			event.locals.user = session.user;
		}

		return await svelteKitHandler({ event, resolve, auth, building });
	} catch (e) {
		// If the DB is down or migrations have not run yet, still serve pages
		// without a session (the layout will redirect to /login) instead of 500ing.
		console.error('auth hook skipped (db down or schema missing?)', e);
		return await resolve(event);
	}
};

export const handle: Handle = handleBetterAuth;
