<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import type { ArticleRow, ArticleSort, ArticleView } from '$lib/article.js';
	import { sortArticles } from '$lib/article.js';
	import ArticleList from '$lib/components/article-list.svelte';
	import MagazineView from '$lib/components/magazine-view.svelte';
	import ArticleViewToggle from '$lib/components/article-view-toggle.svelte';
	import ArticleSortDropdown from '$lib/components/article-sort-dropdown.svelte';
	import SearchBox from '$lib/components/search-box.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { settingsStore } from '$lib/settings.svelte.js';
	import { PanelLeftOpen, RefreshCw } from '@lucide/svelte';

	let {
		articles = [],
		title = 'All stories',
		view = $bindable('grid'),
		sort = $bindable('newest'),
		focusMode = false,
		/** False while saved prefs load — shows a neutral skeleton so the list never flashes the wrong view first. */
		ready = true,
		showImages = true,
		showExcerpts = true,
		showReadMinutes = true,
		density = 'comfortable',
		onExpand,
		onSelect
	}: {
		articles: ArticleRow[];
		title?: string;
		view?: ArticleView;
		sort?: ArticleSort;
		/** In focus mode this list *is* the list — no button to open a second one. */
		focusMode?: boolean;
		ready?: boolean;
		showImages?: boolean;
		showExcerpts?: boolean;
		showReadMinutes?: boolean;
		density?: 'comfortable' | 'compact';
		onExpand?: () => void;
		onSelect?: (id: number) => void;
	} = $props();

	const unreadCount = $derived(articles.filter((a) => !a.isRead).length);
	const topicCount = $derived(new Set(articles.flatMap((a) => a.tags.map((t) => t.id))).size);
	const countLine = $derived(
		view === 'magazine' && topicCount > 0
			? `${articles.length} stories · ${unreadCount} unread · ${topicCount} ${topicCount === 1 ? 'topic' : 'topics'}`
			: `${articles.length} stories · ${unreadCount} unread`
	);
	const sortedArticles = $derived(sortArticles(articles, sort));
	// Refresh-button feedback: spins the icon for the round trip only.
	let refreshing = $state(false);

	onMount(() => {
		if (!settingsStore.ready) return;
		const accountSort = settingsStore.get('defaultSort');
		if (accountSort === 'newest' || accountSort === 'oldest' || accountSort === 'title') {
			sort = accountSort;
		}
		// Only persist user-initiated sort changes after the account default
		// has been applied — otherwise the initial 'newest' would overwrite it.
		sortHydrated = true;
	});

	let sortHydrated = $state(false);

	// Persist user-initiated sort changes to account settings (debounced
	// in the store). The stored value is read inside `untrack` so the write
	// never re-triggers this effect (effect_update_depth_exceeded).
	$effect(() => {
		if (!settingsStore.ready || !sortHydrated) return;
		const current = sort;
		const stored = untrack(() => settingsStore.get('defaultSort'));
		if (stored !== current) {
			settingsStore.set('defaultSort', current);
		}
	});
</script>

<section class="flex min-h-0 flex-1 flex-col bg-background">
	<div class="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-4 sm:px-5">
		<div class="flex min-w-0 flex-1 items-center gap-2">
			<h2
				tabindex="-1"
				data-article-list-heading
				class="truncate text-lg font-bold text-foreground md:text-sm md:font-semibold"
			>
				{title}
			</h2>
			<p class="shrink-0 text-xs text-muted-foreground">
				{countLine}
			</p>
		</div>
		<div class="ml-auto hidden w-56 min-w-0 md:block"><SearchBox /></div>
		<div class="ml-auto flex items-center gap-1 md:ml-0">
			<ArticleViewToggle bind:view />
			<ArticleSortDropdown bind:sort />
			{#if !focusMode}
				<Button
					variant="ghost"
					size="icon-sm"
					class="hidden md:inline-flex"
					onclick={onExpand}
					aria-label="Show article list and reader"
				>
					<PanelLeftOpen />
				</Button>
			{/if}
			<form
				method="POST"
				action="/?/refresh"
				use:enhance={() => {
					refreshing = true;
					return async ({ update }) => {
						await update();
						refreshing = false;
					};
				}}
			>
				<Button
					variant="ghost"
					size="icon-sm"
					class="min-h-11 min-w-11 md:min-h-0 md:min-w-0"
					type="submit"
					aria-label="Refresh feeds"
				>
					<RefreshCw class={refreshing ? 'animate-spin' : undefined} />
				</Button>
			</form>
		</div>
	</div>
	<!-- Magazine view owns its own scroll container and front-page rhythm,
	so it renders outside the row-padding frame used by the other views. -->
	{#if ready && view === 'magazine'}
		<MagazineView articles={sortedArticles} onSelect={(id) => onSelect?.(id) ?? onExpand?.()} />
	{:else}
		<div class="flex min-h-0 w-full flex-1 flex-col pt-4 pb-6 sm:pt-6 sm:pb-8">
			{#if ready}
				<ArticleList
					articles={sortedArticles}
					{view}
					gridClass="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
					{showImages}
					{showExcerpts}
					{showReadMinutes}
					{density}
					onSelect={(id) => onSelect?.(id) ?? onExpand?.()}
				/>
			{:else}
				<div class="flex min-h-0 w-full flex-1 flex-col gap-3 px-4" aria-hidden="true">
					<Skeleton class="h-16 w-full" />
					<Skeleton class="h-16 w-full" />
					<Skeleton class="h-16 w-full" />
					<Skeleton class="h-16 w-full" />
					<Skeleton class="h-16 w-full" />
				</div>
			{/if}
		</div>
	{/if}
</section>
