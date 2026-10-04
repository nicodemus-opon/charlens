<script lang="ts">
	import { page } from '$app/stores';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { mobileActions } from '$lib/mobile-actions.svelte.js';
	import { buildScopeHref, getScopeState } from '$lib/navigation.js';
	import { Bookmark, Library, Newspaper, Search } from '@lucide/svelte';

	const sidebar = Sidebar.useSidebar();

	const scope = $derived(getScopeState($page.url.searchParams));
	const todayCount = $derived(
		Number(($page.data as { counts?: { today?: number } }).counts?.today ?? 0)
	);
	const isToday = $derived(scope.filter === 'today' && !scope.hasScope);
	const isSaved = $derived(scope.filter === 'saved' && !scope.hasScope);

	function scopeHref(params: Record<string, string | null>) {
		return buildScopeHref($page.url, params);
	}
</script>

<!-- Thumb-reach tab bar: overlays the list so stories scroll behind the
frosted bar. The list carries bottom clearance so the last row clears it.
Clears the home indicator via pb-safe. -->
<nav
	aria-label="Primary"
	class="absolute inset-x-0 bottom-0 z-10 flex min-h-14 items-stretch gap-1 border-t border-border bg-background/80 px-2 pt-2 pb-safe backdrop-blur md:hidden"
>
	<Button
		variant={isToday ? 'secondary' : 'ghost'}
		href={scopeHref({ filter: 'today', feed: null, collection: null, view: null })}
		aria-label={todayCount > 0 ? `Today, ${todayCount} unread` : 'Today'}
		aria-current={isToday ? 'page' : undefined}
		class="min-h-11 min-w-0 flex-1"
	>
		<Newspaper />
	</Button>
	<Button
		variant={isSaved ? 'secondary' : 'ghost'}
		href={scopeHref({ filter: 'saved', feed: null, collection: null, view: null })}
		aria-label="Read later"
		aria-current={isSaved ? 'page' : undefined}
		class="min-h-11 min-w-0 flex-1"
	>
		<Bookmark />
	</Button>
	<Button
		variant={mobileActions.paletteOpen ? 'secondary' : 'ghost'}
		aria-label="Search"
		onclick={() => (mobileActions.paletteOpen = true)}
		class="min-h-11 min-w-0 flex-1"
	>
		<Search />
	</Button>
	<Button
		variant="ghost"
		aria-label="Open library"
		onclick={() => sidebar.setOpenMobile(true)}
		class="min-h-11 min-w-0 flex-1"
	>
		<Library />
	</Button>
</nav>
