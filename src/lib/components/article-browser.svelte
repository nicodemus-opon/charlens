<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ArticleRow, ArticleView } from '$lib/article.js';
	import ArticleList from '$lib/components/article-list.svelte';
	import ArticleViewToggle from '$lib/components/article-view-toggle.svelte';
	import SearchBox from '$lib/components/search-box.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { PanelLeftOpen, RefreshCw } from '@lucide/svelte';

	let {
		articles = [],
		title = 'All stories',
		view = $bindable('grid'),
		focusMode = false,
		/** False while saved prefs load — shows a neutral skeleton so the list never flashes the wrong view first. */
		ready = true,
		onExpand,
		onSelect
	}: {
		articles: ArticleRow[];
		title?: string;
		view?: ArticleView;
		/** In focus mode this list *is* the list — no button to open a second one. */
		focusMode?: boolean;
		ready?: boolean;
		onExpand?: () => void;
		onSelect?: (id: number) => void;
	} = $props();

	const unreadCount = $derived(articles.filter((a) => !a.isRead).length);
</script>

<section class="flex min-h-0 flex-1 flex-col bg-background">
	<div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5">
		<div class="flex min-w-0 flex-1 items-center gap-2">
			<h2
				tabindex="-1"
				data-article-list-heading
				class="truncate text-sm font-semibold text-foreground"
			>
				{title}
			</h2>
			<p class="shrink-0 text-xs text-muted-foreground">
				{articles.length} stories · {unreadCount} unread
			</p>
		</div>
		<div class="ml-auto hidden w-56 min-w-0 md:block"><SearchBox /></div>
		<div class="ml-auto flex items-center gap-1 md:ml-0">
			<ArticleViewToggle bind:view />
			{#if !focusMode}
				<Button
					variant="ghost"
					size="icon-sm"
					onclick={onExpand}
					aria-label="Show article list and reader"
				>
					<PanelLeftOpen />
				</Button>
			{/if}
			<form method="POST" action="/?/refresh" use:enhance>
				<Button variant="ghost" size="icon-sm" type="submit" aria-label="Refresh feeds">
					<RefreshCw />
				</Button>
			</form>
		</div>
	</div>
	<!-- Row padding lives on the rows/cards themselves, so the frame only sets vertical rhythm. -->
	<div class="flex min-h-0 w-full flex-1 flex-col pt-4 pb-6 sm:pt-6 sm:pb-8">
		{#if ready}
			<ArticleList
				{articles}
				{view}
				gridClass="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
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
</section>
