<script lang="ts">
	import { page } from '$app/stores';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { mobileActions } from '$lib/mobile-actions.svelte.js';
	import { buildScopeHref, getScopeState } from '$lib/navigation.js';
	import { Bookmark, Library, Newspaper, Plus, Search } from '@lucide/svelte';

	const sidebar = Sidebar.useSidebar();

	const scope = $derived(getScopeState($page.url.searchParams));
	const todayCount = $derived(
		Number(($page.data as { counts?: { today?: number } }).counts?.today ?? 0)
	);
	const isToday = $derived(scope.filter === 'today' && !scope.hasScope);
	const isSaved = $derived(scope.filter === 'saved' && !scope.hasScope);
	const badge = $derived(todayCount <= 0 ? null : todayCount > 99 ? '99+' : String(todayCount));

	function scopeHref(params: Record<string, string | null>) {
		return buildScopeHref($page.url, params);
	}
</script>

<!-- Native tab bar: icon-only tabs with a central Add action. The active
	pill is the selected-state signal; names survive as accessible labels.
	Clears the home indicator via pb-safe. -->
<nav
	aria-label="Primary"
	class="flex min-h-14 items-stretch gap-1 border-t border-border bg-background px-2 pt-2 pb-safe md:hidden"
>
	<Button
		variant={isToday ? 'secondary' : 'ghost'}
		href={scopeHref({ filter: 'today', feed: null, collection: null, view: null })}
		aria-label={todayCount > 0 ? `Today, ${todayCount} unread` : 'Today'}
		aria-current={isToday ? 'page' : undefined}
		class="relative min-h-11 min-w-0 flex-1"
	>
		<Newspaper />
		{#if badge}
			<Badge variant="default" class="absolute top-0 left-3 min-w-5">{badge}</Badge>
		{/if}
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
	<div class="flex min-h-11 min-w-0 flex-1 items-center justify-center">
		<Button
			variant="default"
			size="icon-lg"
			aria-label="Add content"
			onclick={() => (mobileActions.addOpen = true)}
			class="size-12 shrink-0"
		>
			<Plus />
		</Button>
	</div>
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
