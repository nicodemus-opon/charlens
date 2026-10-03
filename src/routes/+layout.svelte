<script lang="ts">
	import { onMount } from 'svelte';
	import '@fontsource-variable/inter/opsz.css';
	import '@fontsource-variable/inter/opsz-italic.css';
	import '@fontsource-variable/jetbrains-mono';
	import './layout.css';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { ModeWatcher, setMode } from 'mode-watcher';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import AppSidebar from '$lib/components/app-sidebar.svelte';
	import ShortcutsDialog from '$lib/components/shortcuts-dialog.svelte';
	import { shortcutsState } from '$lib/shortcuts.svelte.js';
	import { initPwa } from '$lib/pwa';
	import { settingsStore } from '$lib/settings.svelte.js';

	let { children, data } = $props();

	// The login page renders bare — no sidebar, no app chrome.
	const isLogin = $derived($page.route.id === '/login');

	onMount(() => {
		initPwa();
		// Account settings are the cross-device source of truth; the store
		// caches them per-user in localStorage for instant first paint.
		settingsStore.init(
			(data.settings ?? {}) as Record<string, unknown>,
			data.user?.id ?? 'anonymous'
		);
		const theme = settingsStore.get('theme');
		if (theme === 'light' || theme === 'dark' || theme === 'system') setMode(theme);
	});

	function handleShortcut(e: KeyboardEvent) {
		const target = e.target as HTMLElement | null;
		if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
		if ((e.metaKey || e.ctrlKey) && e.key === ',') {
			e.preventDefault();
			goto('/settings');
		}
	}
</script>

<svelte:document onkeydown={handleShortcut} />

<svelte:head>
	<title>charlens</title>
	<link rel="icon" type="image/png" href="/favicon.png" />
	<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png" />
</svelte:head>

<ModeWatcher defaultMode="system" />

{#if isLogin}
	{@render children()}
{:else}
	<Sidebar.Provider open={data.sidebarOpen}>
		<AppSidebar
			feeds={data.feeds}
			collections={data.collections}
			tags={data.tags}
			counts={data.counts}
			user={data.user}
		/>
		<!-- min-w-0: let the inset shrink below the panes' nowrap min-content so the page never overflows horizontally. -->
		<Sidebar.Inset class="min-w-0">
			{@render children()}
		</Sidebar.Inset>
	</Sidebar.Provider>
{/if}
<ShortcutsDialog bind:open={shortcutsState.open} />
