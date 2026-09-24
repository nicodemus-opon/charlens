/*
 * charlens service worker — hand-rolled, no build step, no dependencies.
 * Served straight from static/ by adapter-node.
 *
 * Caching strategy (same-origin GET only; non-GET is never touched):
 *   - navigations            network-first → last visited page → offline page
 *   - /_app/immutable/*      cache-first (content-hashed, safe forever)
 *   - *__data.json           network-first → cache (offline SPA navigation)
 *   - /api/* (except below)  network-first → cache (offline reading)
 *   - everything else        stale-while-revalidate (icons, favicon, fonts…)
 *
 * Never cached: /api/auth/*, /api/feeds/refresh, and any navigation that
 * redirects to /login (an expired session must not overwrite the last good
 * copy of a page). Caches are device-local and version-scoped.
 *
 * Updates: a new worker installs in the background and takes over on the next
 * reload — no skipWaiting, so pages are never yanked mid-read. Bump VERSION
 * whenever the caching behavior below changes (to flush old caches).
 */

const VERSION = 'v1';
const STATIC_CACHE = `charlens-static-${VERSION}`;
const PAGE_CACHE = `charlens-pages-${VERSION}`;
const API_CACHE = `charlens-api-${VERSION}`;
const CURRENT_CACHES = [STATIC_CACHE, PAGE_CACHE, API_CACHE];

// Fetched at install so the offline page can show the logo without the network.
const PRECACHE = ['/manifest.webmanifest', '/logo.png'];

// Self-contained offline fallback: no external assets, light/dark aware,
// colors taken from src/routes/layout.css.
const OFFLINE_HTML = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta name="theme-color" content="#fff8fb" media="(prefers-color-scheme: light)" />
		<meta name="theme-color" content="#262624" media="(prefers-color-scheme: dark)" />
		<title>Offline — charlens</title>
		<style>
			:root {
				color-scheme: light dark;
				--bg: #fff8fb;
				--fg: #3b2f34;
				--muted: #6a5c62;
				--primary: #f8c8d9;
				--primary-fg: #3b2f34;
			}
			@media (prefers-color-scheme: dark) {
				:root {
					--bg: #262624;
					--fg: #c5c2b8;
					--muted: #b8b7ab;
					--primary: #f2c1d3;
					--primary-fg: #262624;
				}
			}
			* {
				box-sizing: border-box;
			}
			body {
				margin: 0;
				min-height: 100vh;
				display: grid;
				place-items: center;
				padding: 24px;
				background: var(--bg);
				color: var(--fg);
				font-family:
					ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial,
					sans-serif;
				text-align: center;
			}
			main {
				max-width: 26rem;
			}
			img {
				width: 72px;
				height: 72px;
			}
			h1 {
				font-size: 1.5rem;
				margin: 16px 0 8px;
			}
			p {
				color: var(--muted);
				line-height: 1.6;
				margin: 0 0 24px;
			}
			button {
				border: 0;
				border-radius: 8px;
				padding: 10px 20px;
				font: inherit;
				font-weight: 600;
				cursor: pointer;
				background: var(--primary);
				color: var(--primary-fg);
			}
		</style>
	</head>
	<body>
		<main>
			<img src="/logo.png" alt="" width="72" height="72" onerror="this.remove()" />
			<h1>You're offline</h1>
			<p>
				charlens can't reach the server right now. Articles you've already opened stay
				readable — reconnect and try again to refresh your feeds.
			</p>
			<button type="button" onclick="location.reload()">Try again</button>
		</main>
	</body>
</html>
`;

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(STATIC_CACHE)
			.then((cache) => cache.addAll(PRECACHE))
			// Never block install on a flaky precache; the fallback page works without it.
			.catch(() => undefined)
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const names = await caches.keys();
			await Promise.all(
				names
					.filter((name) => name.startsWith('charlens-') && !CURRENT_CACHES.includes(name))
					.map((name) => caches.delete(name))
			);
			await self.clients.claim();
		})()
	);
});

self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname.startsWith('/api/auth/')) return;
	if (url.pathname === '/api/feeds/refresh') return;
	// SvelteKit's build-version probe must stay fresh so deploys are noticed.
	if (url.pathname === '/_app/version.json') return;

	if (request.mode === 'navigate') {
		event.respondWith(handleNavigation(request));
		return;
	}
	if (url.pathname.startsWith('/_app/immutable/')) {
		event.respondWith(cacheFirst(request, STATIC_CACHE));
		return;
	}
	if (url.pathname.endsWith('/__data.json')) {
		event.respondWith(networkFirst(request, PAGE_CACHE));
		return;
	}
	if (url.pathname.startsWith('/api/')) {
		event.respondWith(networkFirst(request, API_CACHE));
		return;
	}
	event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
});

/** Network-first pages: always fresh online, last good copy offline. */
async function handleNavigation(request) {
	try {
		const response = await fetch(request);
		// An expired session redirects to /login — return it (the user must log
		// in) but never store it over the last authed copy of this page.
		const expired = response.redirected && new URL(response.url).pathname === '/login';
		if (response.ok && !expired) {
			const cache = await caches.open(PAGE_CACHE);
			await cache.put(request, response.clone());
		}
		return response;
	} catch {
		// ignoreVary: HTML may vary by cookie; this cache is per-device and we
		// want the last read copy regardless of the current session headers.
		const cached = await caches.match(request, { ignoreVary: true });
		return cached ?? offlinePage();
	}
}

/** Network-first with cache fallback for API payloads and SvelteKit data. */
async function networkFirst(request, cacheName) {
	try {
		const response = await fetch(request);
		if (response.ok) {
			const cache = await caches.open(cacheName);
			await cache.put(request, response.clone());
		}
		return response;
	} catch {
		const cached = await caches.match(request, { ignoreVary: true });
		return (
			cached ??
			new Response(JSON.stringify({ error: 'offline' }), {
				status: 503,
				headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
			})
		);
	}
}

/** Cache-first for content-hashed assets — identical URL, identical bytes. */
async function cacheFirst(request, cacheName) {
	const cache = await caches.open(cacheName);
	const cached = await cache.match(request);
	if (cached) return cached;
	const response = await fetch(request);
	if (response.ok) await cache.put(request, response.clone());
	return response;
}

/** Serve instantly from cache, refresh in the background (icons, favicon…). */
async function staleWhileRevalidate(request, cacheName) {
	const cache = await caches.open(cacheName);
	const cached = await cache.match(request, { ignoreVary: true });
	const refresh = fetch(request)
		.then((response) => {
			if (response.ok) void cache.put(request, response.clone());
			return response;
		})
		.catch(() => undefined);
	if (cached) return cached; // background refresh already running
	const response = await refresh;
	return response ?? Response.error();
}

function offlinePage() {
	return new Response(OFFLINE_HTML, {
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
	});
}
