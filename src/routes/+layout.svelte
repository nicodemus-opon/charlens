<script lang="ts">
	import './layout.css';
	import { page } from '$app/stores';
	import { ModeWatcher } from 'mode-watcher';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import AppSidebar from '$lib/components/app-sidebar.svelte';

	let { children, data } = $props();

	// The login page renders bare — no sidebar, no app chrome.
	const isLogin = $derived($page.route.id === '/login');
</script>

<svelte:head>
	<title>charlens</title>
	<link rel="icon" type="image/png" href="/favicon.png" />
	<link rel="apple-touch-icon" href="/logo.png" />
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
