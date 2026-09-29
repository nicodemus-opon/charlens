<script lang="ts">
	import { page } from '$app/stores';
	import type { ArticleRow } from '$lib/article.js';
	import ArticleImage from '$lib/components/article-image.svelte';
	import { buildMagazineSections } from '$lib/magazine.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { cn } from '$lib/utils.js';
	import { Clock, Newspaper } from '@lucide/svelte';

	let {
		articles = [],
		title = 'All stories',
		href,
		tagHref,
		emptyTitle = 'No articles yet',
		emptyDescription = 'Add a feed or hit refresh to pull the latest stories.',
		onSelect
	}: {
		articles: ArticleRow[];
		title?: string;
		href?: (id: number) => string;
		/**
		 * Builds the href for a topic. Defaults to scoping the list to that tag
		 * on the current URL; override when there is no SvelteKit `$page`
		 * context (e.g. component tests).
		 */
		tagHref?: (tagId: number) => string;
		emptyTitle?: string;
		emptyDescription?: string;
		onSelect?: (id: number) => void;
	} = $props();

	const selectedId = $derived(href ? null : $page.url.searchParams.get('article'));
	const sections = $derived(buildMagazineSections(articles));

	function articleHref(id: number) {
		if (href) return href(id);
		const url = new URL($page.url);
		url.searchParams.set('article', String(id));
		return `${url.pathname}?${url.searchParams.toString()}`;
	}

	/**
	 * Topic chips and desk headers open the list scoped to that tag: the
	 * previous scope (feed/collection/smart view/search) is dropped and the
	 * article is cleared so the tag view reads unambiguously.
	 */
	function tagFilterHref(tagId: number) {
		if (tagHref) return tagHref(tagId);
		const url = new URL($page.url);
		url.searchParams.set('filter', 'all');
		url.searchParams.set('tag', String(tagId));
		url.searchParams.delete('feed');
		url.searchParams.delete('collection');
		url.searchParams.delete('view');
		url.searchParams.delete('q');
		url.searchParams.delete('article');
		return `${url.pathname}?${url.searchParams.toString()}`;
	}

	/** Desk grids tighten as the story count drops so small desks never look stranded. */
	function deskGridClass(count: number) {
		if (count >= 3) return 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3';
		return 'grid gap-3 sm:grid-cols-2';
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

	function byline(a: ArticleRow) {
		const parts = [a.feedTitle];
		if (a.author) parts.push(a.author);
		const date = dateLabel(a.publishedAt);
		if (date) parts.push(date);
		return parts.join(' · ');
	}

	const editionDate = new Date().toLocaleDateString(undefined, {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		year: 'numeric'
	});
	const unreadCount = $derived(articles.filter((a) => !a.isRead).length);
	const topicCount = $derived(new Set(articles.flatMap((a) => a.tags.map((t) => t.id))).size);
	const editionLine = $derived(
		`${articles.length} stories · ${unreadCount} unread${topicCount > 0 ? ` · ${topicCount} ${topicCount === 1 ? 'topic' : 'topics'}` : ''}`
	);
</script>

{#snippet kicker(a: ArticleRow)}
	<div class="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
		<span class="truncate font-medium">{a.feedTitle}</span>
		{#if !a.isRead}<Badge variant="default">New</Badge>{/if}
		{#if a.isSaved}<Badge variant="secondary">Saved</Badge>{/if}
		{#if a.tags[0]}
			<Badge variant="outline" href={tagFilterHref(a.tags[0].id)} class="max-w-36 justify-start">
				<span class="min-w-0 truncate">{a.tags[0].name}</span>
			</Badge>
		{/if}
	</div>
{/snippet}

{#snippet thumb(a: ArticleRow, sizes: string)}
	<ArticleImage seed={a} src={a.imageUrl} alt="" class={cn('w-full', sizes)} />
{/snippet}

{#if articles.length === 0 || !sections.lead}
	<div class="flex flex-1 items-center justify-center p-6">
		<Empty.Root>
			<Empty.Header>
				<Empty.Media variant="icon"><Newspaper /></Empty.Media>
				<Empty.Title>{emptyTitle}</Empty.Title>
				<Empty.Description>{emptyDescription}</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	</div>
{:else}
	{@const lead = sections.lead}
	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto w-full max-w-7xl px-4 pb-8 sm:px-5">
			<div class="flex flex-col gap-1 py-4">
				<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
					{editionDate}
				</p>
				<h1 class="text-2xl font-bold tracking-tight text-balance text-foreground sm:text-3xl">
					{title}
				</h1>
				<p class="text-xs text-muted-foreground">
					{editionLine}
				</p>
			</div>
			<Separator />
			<div class="grid gap-3 py-4 lg:grid-cols-3">
				<a
					href={articleHref(lead.id)}
					onclick={() => onSelect?.(lead.id)}
					aria-current={selectedId === String(lead.id) ? 'true' : undefined}
					class={cn(
						'block min-w-0 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none lg:col-span-2',
						selectedId === String(lead.id) && 'ring-2 ring-ring'
					)}
				>
					<Card.Root class="h-full min-w-0 overflow-hidden">
						{@render thumb(lead, 'aspect-video')}
						<Card.Content class="flex min-w-0 flex-1 flex-col">
							<div class="flex min-w-0 flex-col gap-2">
								{@render kicker(lead)}
								<h2
									class="line-clamp-2 text-xl font-bold tracking-tight text-balance text-foreground"
								>
									{lead.title}
								</h2>
								{#if lead.excerpt}
									<p class="line-clamp-1 text-xs text-muted-foreground">{lead.excerpt}</p>
								{/if}
								<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
									<span class="truncate">{byline(lead)}</span>
									{#if lead.readMinutes}
										<span class="flex shrink-0 items-center gap-1">
											<Clock class="size-3" />
											{lead.readMinutes} min
										</span>
									{/if}
								</p>
							</div>
						</Card.Content>
					</Card.Root>
				</a>
				{#if sections.secondary.length > 0}
					<div class="flex min-w-0 flex-col gap-3">
						{#each sections.secondary as a (a.id)}
							{@const isSelected = selectedId === String(a.id)}
							<a
								href={articleHref(a.id)}
								onclick={() => onSelect?.(a.id)}
								aria-current={isSelected ? 'true' : undefined}
								class={cn(
									'block min-w-0 flex-1 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
									isSelected && 'ring-2 ring-ring'
								)}
							>
								<Card.Root class="h-full min-w-0 overflow-hidden">
									{@render thumb(a, 'aspect-video')}
									<Card.Content class="flex min-w-0 flex-1 flex-col">
										<div class="flex min-w-0 flex-col gap-1">
											{@render kicker(a)}
											<h3
												class="line-clamp-2 text-base font-bold tracking-tight text-balance text-foreground"
											>
												{a.title}
											</h3>
											<p class="truncate text-xs text-muted-foreground">{byline(a)}</p>
										</div>
									</Card.Content>
								</Card.Root>
							</a>
						{/each}
					</div>
				{/if}
			</div>
			{#if sections.latest.length > 0}
				<div class="flex items-center gap-3 py-3">
					<h2 class="shrink-0 text-base font-bold tracking-tight text-foreground">Latest</h2>
					<Separator class="flex-1" />
				</div>
				<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
					{#each sections.latest as a (a.id)}
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
							<Card.Root class="min-w-0">
								<Card.Content class="flex min-w-0 flex-row gap-3">
									<div class="flex min-w-0 flex-1 flex-col gap-1">
										{@render kicker(a)}
										<h3
											class="line-clamp-2 text-sm font-bold tracking-tight text-balance text-foreground"
										>
											{a.title}
										</h3>
										{#if a.excerpt}
											<p class="line-clamp-2 text-xs text-muted-foreground">{a.excerpt}</p>
										{/if}
										<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
											<span class="truncate">{byline(a)}</span>
											{#if a.readMinutes}
												<span class="flex shrink-0 items-center gap-1">
													<Clock class="size-3" />
													{a.readMinutes} min
												</span>
											{/if}
										</p>
									</div>
									<div class="w-20 shrink-0 overflow-hidden rounded-lg">
										{@render thumb(a, 'aspect-square h-full')}
									</div>
								</Card.Content>
							</Card.Root>
						</a>
					{/each}
				</div>
			{/if}
			{#each sections.desks as desk (desk.tag.id)}
				<div class="flex items-center gap-3 py-3">
					<h2 class="shrink-0 text-base font-bold tracking-tight text-foreground capitalize">
						{desk.tag.name}
					</h2>
					<Separator class="flex-1" />
					<a
						href={tagFilterHref(desk.tag.id)}
						class="shrink-0 text-xs font-medium text-primary hover:underline focus-visible:outline-none"
					>
						View all
					</a>
				</div>
				<div class={deskGridClass(desk.articles.length)}>
					{#each desk.articles as a (a.id)}
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
							<Card.Root class="h-full min-w-0 overflow-hidden">
								{@render thumb(a, 'aspect-video')}
								<Card.Content class="flex min-w-0 flex-1 flex-col">
									<div class="flex min-w-0 flex-col gap-1">
										{@render kicker(a)}
										<h3
											class="line-clamp-2 text-sm font-bold tracking-tight text-balance text-foreground"
										>
											{a.title}
										</h3>
										<p class="truncate text-xs text-muted-foreground">{byline(a)}</p>
									</div>
								</Card.Content>
							</Card.Root>
						</a>
					{/each}
				</div>
			{/each}
			{#if sections.rest.length > 0}
				<div class="flex items-center gap-3 py-3">
					<h2 class="shrink-0 text-base font-bold tracking-tight text-foreground">
						More headlines
					</h2>
					<Separator class="flex-1" />
				</div>
				<div class="overflow-hidden rounded-xl border border-border bg-card">
					{#each sections.rest as a (a.id)}
						{@const isSelected = selectedId === String(a.id)}
						<a
							href={articleHref(a.id)}
							onclick={() => onSelect?.(a.id)}
							aria-current={isSelected ? 'true' : undefined}
							class={cn(
								'flex min-w-0 items-center gap-3 border-b border-border px-4 py-2 transition-colors last:border-b-0 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none active:bg-accent',
								isSelected && 'bg-accent'
							)}
						>
							<span class="flex min-w-0 flex-1 flex-col gap-0.5">
								<span class="truncate text-sm font-medium text-foreground">{a.title}</span>
								<span class="truncate text-xs text-muted-foreground">{byline(a)}</span>
							</span>
							<span class="shrink-0 text-xs text-muted-foreground">
								{a.readMinutes ? `${a.readMinutes} min` : dateLabel(a.publishedAt)}
							</span>
						</a>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}
