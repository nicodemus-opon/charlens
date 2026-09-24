/**
 * PWA bootstrap: service-worker registration (production only, so dev/HMR is
 * never served from caches) and keeping `<meta name="theme-color">` in sync
 * with ModeWatcher, which toggles the `.dark` class on `<html>` for all three
 * modes (light / dark / system).
 *
 * Hex values mirror src/routes/layout.css `--background`:
 *   light oklch(0.985 0.008 350) → #fff8fb
 *   dark  oklch(0.2679 0.0036 106.6427) → #262624
 */
const LIGHT_THEME_COLOR = '#fff8fb';
const DARK_THEME_COLOR = '#262624';

/** Follow the resolved color scheme so standalone status bars stay correct. */
function syncThemeColor(): () => void {
	const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	const apply = () => {
		if (!meta) return;
		const dark = document.documentElement.classList.contains('dark');
		meta.content = dark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
	};
	apply();
	const observer = new MutationObserver(apply);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
	return () => observer.disconnect();
}

/** Register /sw.js and keep it eligible for updates in long-lived tabs. */
function registerServiceWorker(): () => void {
	if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return () => {};

	let registration: ServiceWorkerRegistration | undefined;
	const update = () => {
		// A reader tab can stay open all day; re-check for deploys when the tab
		// regains focus and hourly, so waiting workers activate on the next reload.
		registration?.update().catch(() => undefined);
	};

	navigator.serviceWorker
		.register('/sw.js')
		.then((r) => {
			registration = r;
			document.addEventListener('visibilitychange', update);
		})
		// e.g. a non-secure origin — the app still works, just not installable.
		.catch(() => undefined);

	const interval = setInterval(update, 60 * 60 * 1000);
	return () => {
		document.removeEventListener('visibilitychange', update);
		clearInterval(interval);
	};
}

/** Called once from the root layout's `onMount`; returns a teardown. */
export function initPwa(): () => void {
	const stopThemeSync = syncThemeColor();
	const stopServiceWorker = registerServiceWorker();
	return () => {
		stopThemeSync();
		stopServiceWorker();
	};
}
