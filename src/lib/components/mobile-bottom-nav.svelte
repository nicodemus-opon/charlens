<script lang="ts">
	import { page } from '$app/stores';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { mobileActions } from '$lib/mobile-actions.svelte.js';
	import { Bookmark, Menu, Newspaper, Plus, Search } from '@lucide/svelte';

	const sidebar = Sidebar.useSidebar();

	const filter = $derived($page.url.searchParams.get('filter') ?? 'today');
	const hasScope = $derived(
		$page.url.searchParams.has('feed') ||
			$page.url.searchParams.has('collection') ||
			$page.url.searchParams.has('view')
	);

	function scopeHref(params: Record<string, string | null>) {
		const url = new URL($page.url);
		url.searchParams.delete('tag');
		for (const [k, v] of Object.entries(params)) {
			if (v === null) url.searchParams.delete(k);
			else url.searchParams.set(k, v);
		}
		url.searchParams.delete('article');
		return `${url.pathname}?${url.searchParams.toString()}`;
	}
</script>

<!-- Thumb-reach nav for phones: the sidebar drawer, palette and add-feed
	dialog stay desktop-owned, this bar only links or flips them open.
	Labels appear from sm up; below that the bar is icon-only (with
	accessible names) so five tabs fit a 360px viewport. -->
<nav
	aria-label="Primary"
	class="flex items-stretch gap-1 border-t border-border bg-background px-2 pt-2 pb-safe md:hidden"
>
	<Button
		variant={filter === 'today' && !hasScope ? 'secondary' : 'ghost'}
		size="lg"
		href={scopeHref({ filter: 'today', feed: null, collection: null, view: null })}
		aria-label="Today"
		class="min-w-0 flex-1"
	>
		<Newspaper />
		<span class="hidden truncate sm:inline">Today</span>
	</Button>
	<Button
		variant={filter === 'saved' && !hasScope ? 'secondary' : 'ghost'}
		size="lg"
		href={scopeHref({ filter: 'saved', feed: null, collection: null, view: null })}
		aria-label="Read later"
		class="min-w-0 flex-1"
	>
		<Bookmark />
		<span class="hidden truncate sm:inline">Saved</span>
	</Button>
	<Button
		variant="ghost"
		size="lg"
		aria-label="Search"
		onclick={() => (mobileActions.paletteOpen = true)}
		class="min-w-0 flex-1"
	>
		<Search />
		<span class="hidden truncate sm:inline">Search</span>
	</Button>
	<Button
		variant="ghost"
		size="lg"
		aria-label="Add content"
		onclick={() => (mobileActions.addOpen = true)}
		class="min-w-0 flex-1"
	>
		<Plus />
		<span class="hidden truncate sm:inline">Add</span>
	</Button>
	<Button
		variant="ghost"
		size="lg"
		aria-label="Open menu"
		onclick={() => sidebar.setOpenMobile(true)}
		class="min-w-0 flex-1"
	>
		<Menu />
		<span class="hidden truncate sm:inline">Menu</span>
	</Button>
</nav>
