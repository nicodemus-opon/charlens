<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/stores';
	import type { ArticleRow, ArticleView } from '$lib/article.js';
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import { cn } from '$lib/utils.js';
	import { Bookmark, BookmarkCheck, Clock, Newspaper } from '@lucide/svelte';

	let {
		articles = [],
		view = 'list',
		gridClass = 'grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
		href,
		emptyTitle = 'No articles yet',
		emptyDescription = 'Add a feed or hit refresh to pull the latest stories.',
		onSelect
	}: {
		articles: ArticleRow[];
		view?: ArticleView;
		/** Grid columns used when `view` is `grid` — differs per layout context. */
		gridClass?: string;
		/**
		 * Builds the href for an article. Defaults to setting the `article` search param on the
		 * current URL; override when there is no SvelteKit `$page` context (e.g. component tests).
		 */
		href?: (id: number) => string;
		emptyTitle?: string;
		emptyDescription?: string;
		onSelect?: (id: number) => void;
	} = $props();

	const selectedId = $derived(href ? null : $page.url.searchParams.get('article'));

	// Tracks images that failed to load so grid cards fall back to the feed avatar.
	let failedImages = $state(new Set<number>());

	function articleHref(id: number) {
		if (href) return href(id);
		const url = new URL($page.url);
		url.searchParams.set('article', String(id));
		return `${url.pathname}?${url.searchParams.toString()}`;
	}

	function feedInitials(title: string) {
		return title.slice(0, 2).toUpperCase();
	}

	function dateLabel(d: Date | string | null) {
		if (!d) return '';
		const date = d instanceof Date ? d : new Date(d);
		const now = new Date();
		const days = Math.floor((now.getTime() - date.getTime()) / 86400000);
		if (days <= 0) return 'Today';
		if (days === 1) return 'Yesterday';
		return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}
</script>

{#if articles.length === 0}
	<div class="flex flex-1 items-center justify-center p-6">
		<Empty.Root>
			<Empty.Header>
				<Empty.Media variant="icon"><Newspaper /></Empty.Media>
				<Empty.Title>{emptyTitle}</Empty.Title>
				<Empty.Description>{emptyDescription}</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	</div>
{:else if view === 'grid'}
	<div
		class={cn(
			'grid min-h-0 flex-1 items-start gap-4 overflow-y-auto p-4 sm:gap-6 sm:p-5',
			gridClass
		)}
	>
		{#each articles as a (a.id)}
			{@const isSelected = selectedId === String(a.id)}
			<a
				href={articleHref(a.id)}
				onclick={() => onSelect?.(a.id)}
				aria-current={isSelected ? 'true' : undefined}
				class={cn(
					'block min-w-0 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
					isSelected && 'ring-2 ring-ring'
				)}
			>
				<Card.Root class="h-full min-w-0">
					{#if a.imageUrl && !failedImages.has(a.id)}
						<img
							src={a.imageUrl}
							alt=""
							loading="lazy"
							onerror={() => failedImages.add(a.id)}
							class="aspect-video w-full bg-muted object-cover"
						/>
					{:else}
						<div class="flex aspect-video w-full items-center justify-center bg-muted">
							<Avatar.Root class="size-8">
								<Avatar.Fallback>{feedInitials(a.feedTitle)}</Avatar.Fallback>
							</Avatar.Root>
						</div>
					{/if}
					<Card.Content class="flex min-w-0 flex-1 flex-col">
						<div class="flex min-w-0 flex-col gap-1">
							<div class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
								<span class="truncate font-medium">{a.feedTitle}</span>
								{#if a.readMinutes}
									<span class="flex shrink-0 items-center gap-1">
										<Clock class="size-3" />
										{a.readMinutes} min
									</span>
								{/if}
								{#if !a.isRead}<Badge variant="default">New</Badge>{/if}
								{#if a.isSaved}<Badge variant="secondary">Saved</Badge>{/if}
								{#if a.tags[0]}
									<Badge variant="outline" class="max-w-36 justify-start">
										<span class="min-w-0 truncate">{a.tags[0].name}</span>
									</Badge>
								{/if}
							</div>
							<Card.Title class="line-clamp-2">{a.title}</Card.Title>
						</div>
					</Card.Content>
				</Card.Root>
			</a>
		{/each}
	</div>
{:else if view === 'compact'}
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#each articles as a (a.id)}
			{@const isSelected = selectedId === String(a.id)}
			<div
				class={cn(
					'flex items-center gap-2 border-b border-border px-4 py-2 transition-colors hover:bg-accent sm:px-5 sm:py-1.5',
					isSelected && 'bg-accent'
				)}
			>
				<form method="POST" action="/?/toggleSaved" use:enhance>
					<input type="hidden" name="id" value={a.id} />
					<Button variant="ghost" size="icon-sm" type="submit" aria-label="Save for later">
						{#if a.isSaved}<BookmarkCheck />{:else}<Bookmark />{/if}
					</Button>
				</form>
				<a
					href={articleHref(a.id)}
					onclick={() => onSelect?.(a.id)}
					aria-current={isSelected ? 'true' : undefined}
					class={cn(
						'flex min-w-0 flex-1 items-center gap-4 text-sm focus-visible:bg-accent focus-visible:outline-none',
						isSelected && 'bg-accent'
					)}
				>
					<span class="hidden max-w-36 truncate text-muted-foreground sm:inline">{a.feedTitle}</span
					>
					<span class="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
						<span class="min-w-0 flex-1 truncate font-semibold text-foreground sm:flex-none"
							>{a.title}</span
						>
						{#if a.excerpt}
							<span class="hidden truncate text-muted-foreground sm:inline">{a.excerpt}</span>
						{/if}
					</span>
					<span class="shrink-0 text-muted-foreground">
						{a.readMinutes ? `${a.readMinutes}min` : dateLabel(a.publishedAt)}
					</span>
				</a>
			</div>
		{/each}
	</div>
{:else}
	<div class="@container min-h-0 flex-1 overflow-y-auto">
		{#each articles as a (a.id)}
			{@const isSelected = selectedId === String(a.id)}
			<a
				href={articleHref(a.id)}
				onclick={() => onSelect?.(a.id)}
				aria-current={isSelected ? 'true' : undefined}
				class={cn(
					'flex w-full items-start gap-4 border-b border-border px-4 py-3 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none sm:px-5 sm:py-4',
					isSelected && 'bg-accent'
				)}
			>
				{#if a.imageUrl}
					<img
						src={a.imageUrl}
						alt=""
						loading="lazy"
						class="size-14 shrink-0 rounded-lg bg-muted object-cover @sm:size-16 @md:size-20 @lg:size-24"
					/>
				{:else}
					<Avatar.Root class="size-14 shrink-0 @sm:size-16 @md:size-20 @lg:size-24">
						<Avatar.Fallback>{feedInitials(a.feedTitle)}</Avatar.Fallback>
					</Avatar.Root>
				{/if}
				<div class="flex min-w-0 flex-1 flex-col gap-1.5">
					<div class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
						<span class="truncate">{a.feedTitle}</span>
						<span aria-hidden="true">·</span>
						<span class="shrink-0">{dateLabel(a.publishedAt)}</span>
						{#if a.readMinutes}
							<span class="flex shrink-0 items-center gap-1">
								<Clock class="size-3" />
								{a.readMinutes} min
							</span>
						{/if}
					</div>
					<p class="line-clamp-2 text-sm font-medium text-foreground">{a.title}</p>
					{#if a.excerpt}
						<p class="line-clamp-2 text-xs text-muted-foreground">{a.excerpt}</p>
					{/if}
					{#if !a.isRead || a.isSaved || a.tags.length > 0}
						<div class="flex min-w-0 flex-wrap items-center gap-1.5 overflow-hidden pt-1.5">
							{#if !a.isRead}<Badge variant="default" class="shrink-0">New</Badge>{/if}
							{#if a.isSaved}<Badge variant="secondary" class="shrink-0">Saved</Badge>{/if}
							{#each a.tags.slice(0, 3) as t (t.id)}
								<Badge variant="outline" class="max-w-36 justify-start">
									<span class="min-w-0 truncate">{t.name}</span>
								</Badge>
							{/each}
						</div>
					{/if}
				</div>
			</a>
		{/each}
	</div>
{/if}
