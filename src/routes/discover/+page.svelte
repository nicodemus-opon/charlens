<script lang="ts">
	import { goto } from '$app/navigation';
	import { navigating, page } from '$app/stores';
	import { List, LoaderCircle, Plus } from '@lucide/svelte';
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as ButtonGroup from '$lib/components/ui/button-group/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Item from '$lib/components/ui/item/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Pagination from '$lib/components/ui/pagination/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { faviconUrl } from '$lib/feed-icon.js';
	import type { DiscoverCandidate } from '$lib/server/rss/discovery.js';
	import type { QuickVerifyResult } from '$lib/server/rss/parser.js';

	let { data } = $props();

	let query = $state(data.q ?? '');
	let collection = $state('General');
	let customCollection = $state('');
	let isNewCollection = $state(false);
	/** Streamed feed verification per candidate id (keyword mode only). */
	let verified = $state<Record<string, QuickVerifyResult> | null>(null);

	// Navigating between searches (sort switch, topic chip) loads new data —
	// keep the box showing the active query.
	$effect(() => {
		query = data.q ?? '';
	});

	// Verification streams separately from the page so rows render first
	// and flip states as results land. Handles both the pending promise and
	// the resolved value (SvelteKit swaps the promise for its result once
	// streamed — calling .then on that would throw).
	$effect(() => {
		const incoming = (data as { verified?: unknown }).verified;
		if (
			incoming &&
			typeof (incoming as Promise<Record<string, QuickVerifyResult>>).then === 'function'
		) {
			verified = null;
			let live = true;
			(incoming as Promise<Record<string, QuickVerifyResult>>).then(
				(m) => {
					if (live) verified = m;
				},
				() => {
					if (live) verified = {};
				}
			);
			return () => {
				live = false;
			};
		}
		verified = (incoming as Record<string, QuickVerifyResult> | undefined) ?? null;
	});

	const suggestions = $derived(
		[...new Set([...(data.collections ?? []).map((c) => c.name), 'General'])]
			.map((c) => c.trim())
			.filter(Boolean)
			.sort((a, b) => a.localeCompare(b))
	);

	$effect(() => {
		if (!suggestions.includes(collection)) collection = 'General';
	});

	const sort = $derived(data.sort ?? 'best');

	// Tag chips, sort links, and the search form all trigger a full page
	// reload (the publisher lookup can take seconds) — show skeletons so
	// the navigation reads as loading instead of stalled stale content.
	const isNavigating = $derived($navigating !== null);

	// Sites definitively without a feed never show: once verification lands,
	// web rows with status 'no' drop out (pending/transient rows stay put).
	const visibleCandidates = $derived(
		(data.candidates as DiscoverCandidate[]).filter(
			(c) =>
				c.namespace !== 'web' || c.subscribed || (verified?.[c.id]?.status ?? 'pending') !== 'no'
		)
	);

	function sortHref(next: string) {
		const url = new URL($page.url);
		url.searchParams.set('sort', next);
		return `${url.pathname}?${url.searchParams.toString()}`;
	}

	function pageHref(next: number) {
		const url = new URL($page.url);
		if (next <= 1) url.searchParams.delete('page');
		else url.searchParams.set('page', String(next));
		return `${url.pathname}?${url.searchParams.toString()}`;
	}

	function topicHref(topic: string) {
		return `/discover?q=${encodeURIComponent(topic)}&sort=${sort}`;
	}

	function previewHref(c: DiscoverCandidate) {
		return `/discover/preview?url=${encodeURIComponent(c.url)}`;
	}

	function previewHrefFor(id: string, fallback: string) {
		const v = verified?.[id];
		const target = v?.status === 'ok' && v.url ? v.url : fallback;
		return `/discover/preview?url=${encodeURIComponent(target)}`;
	}

	function followUrlFor(c: DiscoverCandidate) {
		const v = verified?.[c.id];
		return v?.status === 'ok' && v.url ? v.url : c.url;
	}

	function initialFor(title: string, domain: string) {
		const src = (domain || title || '?').trim();
		return (src[0] ?? '?').toUpperCase();
	}

	function onSearch(e: SubmitEvent) {
		e.preventDefault();
		const url = new URL($page.url);
		if (query.trim()) url.searchParams.set('q', query.trim());
		else url.searchParams.delete('q');
		url.searchParams.set('sort', sort);
		url.searchParams.delete('page');
		goto(`/discover?${url.searchParams.toString()}`);
	}

	function followCollection() {
		return isNewCollection && customCollection.trim() ? customCollection.trim() : collection;
	}
</script>

<svelte:head>
	<title>Discover charlens</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8">
	<div class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold text-foreground">Discover</h1>
		<p class="text-sm text-muted-foreground">
			Search topics, site names, or paste any URL: a feed, a site, a channel, anything.
		</p>
	</div>

	<div class="sticky top-0 z-10 -mx-4 bg-background/80 px-4 py-3 backdrop-blur">
		<form onsubmit={onSearch} class="flex flex-col gap-3 sm:flex-row">
			<Input
				name="q"
				type="search"
				placeholder="Try a topic, a site name, or a URL…"
				autocomplete="off"
				bind:value={query}
			/>
			<Button type="submit" disabled={isNavigating} class="shrink-0">
				{#if isNavigating}
					<LoaderCircle class="animate-spin" />
				{/if}
				Search
			</Button>
		</form>
	</div>

	{#if !data.rsshubOk && data.mode === 'url' && !isNavigating}
		<Card.Root class="w-full">
			<Card.Content>
				<p class="text-sm text-muted-foreground">
					The RSSHub instance is unreachable, so route suggestions are unavailable. You can still
					follow direct feed URLs. They will be fetched as usual.
				</p>
			</Card.Content>
		</Card.Root>
	{/if}

	{#if isNavigating}
		<div class="flex flex-col gap-3" aria-hidden="true">
			<Skeleton class="h-16 w-full" />
			<Skeleton class="h-16 w-full" />
			<Skeleton class="h-16 w-full" />
			<Skeleton class="h-16 w-full" />
			<Skeleton class="h-16 w-full" />
		</div>
	{:else if data.mode === 'empty'}
		<Empty.Root>
			<Empty.Content>
				<div class="flex w-full flex-col gap-3">
					<h2 class="text-sm font-semibold text-foreground">Browse by your topics</h2>
					{#if data.topics.length > 0}
						<div class="flex flex-wrap justify-center gap-2">
							{#each data.topics as topic (topic)}
								<Button variant="outline" size="sm" href={topicHref(topic)}>#{topic}</Button>
							{/each}
						</div>
					{:else}
						<p class="text-sm text-muted-foreground">
							Tags you add to articles will show up here as quick searches.
						</p>
					{/if}
				</div>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<div class="flex flex-wrap items-center gap-2">
			<ButtonGroup.Root class="shrink-0">
				<Button variant={sort === 'best' ? 'secondary' : 'ghost'} size="sm" href={sortHref('best')}>
					Best match
				</Button>
				<Button
					variant={sort === 'relevance' ? 'secondary' : 'ghost'}
					size="sm"
					href={sortHref('relevance')}
				>
					Relevance
				</Button>
				<Button variant={sort === 'az' ? 'secondary' : 'ghost'} size="sm" href={sortHref('az')}>
					A–Z
				</Button>
			</ButtonGroup.Root>
			<span class="ml-auto text-xs text-muted-foreground">
				{data.total}
				{data.total === 1 ? 'result' : 'results'}
			</span>
		</div>

		{#if data.failed}
			<Card.Root class="w-full">
				<Card.Content>
					<p class="text-sm text-destructive">
						Discovery failed. The RSSHub instance may be down. Try again in a bit, or follow a
						direct feed URL.
					</p>
				</Card.Content>
			</Card.Root>
		{/if}

		<div class="flex flex-col gap-2">
			<Label for="discover-collection">Add to collection</Label>
			{#if isNewCollection}
				<div class="flex gap-2">
					<Input
						id="discover-collection"
						placeholder="New collection name"
						autocomplete="off"
						bind:value={customCollection}
					/>
					<Button
						variant="outline"
						size="sm"
						type="button"
						onclick={() => {
							isNewCollection = false;
							customCollection = '';
						}}
					>
						<List />Existing
					</Button>
				</div>
			{:else}
				<div class="flex gap-2">
					<Select.Root type="single" bind:value={collection}>
						<Select.Trigger id="discover-collection" size="sm" class="w-full">
							<Select.Value placeholder="Select a collection" />
						</Select.Trigger>
						<Select.Content>
							{#each suggestions as c (c)}
								<Select.Item value={c}>{c}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					<Button
						variant="outline"
						size="sm"
						type="button"
						onclick={() => (isNewCollection = true)}
					>
						<Plus />New
					</Button>
				</div>
			{/if}
		</div>

		{#if data.total === 0 && !data.failed}
			<p class="text-sm text-muted-foreground">No results for “{data.q}”.</p>
		{/if}

		<div class="flex flex-col gap-3">
			{#each visibleCandidates as c (c.id)}
				{@const icon = faviconUrl(c.domain || c.url, c.url)}
				<Item.Root variant="outline">
					<Avatar.Root size="sm" variant="feed" class="hidden shrink-0 sm:flex">
						{#if icon}
							<Avatar.Image src={icon} alt={c.title} variant="feed" />
						{/if}
						<Avatar.Fallback variant="feed">{initialFor(c.title, c.domain)}</Avatar.Fallback>
					</Avatar.Root>
					<Item.Content class="min-w-0 flex-1">
						<Item.Title class="w-full min-w-0">
							<span class="min-w-0 flex-1 truncate">{c.title}</span>
						</Item.Title>
						<Item.Description>
							{#if c.routePath}
								<span>{c.domain}</span>
							{:else}
								<span>Direct feed {c.domain}</span>
							{/if}
						</Item.Description>
					</Item.Content>
					<Item.Actions class="ml-auto shrink-0">
						{#if c.subscribed}
							<Badge variant="secondary" class="shrink-0">Following</Badge>
						{/if}
						{#if c.needsParams}
							<Badge variant="outline" class="shrink-0">Needs details</Badge>
						{/if}
						{#if c.namespace === 'web' && !c.subscribed}
							{@const state = verified?.[c.id]?.status}
							{#if state === 'ok' || state === 'retry'}
								<Button variant="outline" size="sm" href={previewHrefFor(c.id, c.url)}>
									Preview
								</Button>
								<form method="POST" action="/discover?/follow" class="contents">
									<input type="hidden" name="url" value={followUrlFor(c)} />
									<input type="hidden" name="collection" value={followCollection()} />
									<Button variant="default" size="sm" type="submit">Follow</Button>
								</form>
							{:else}
								<Skeleton class="h-7 w-16" />
								<Skeleton class="h-7 w-20" />
							{/if}
						{:else if c.url}
							<Button variant="outline" size="sm" href={previewHref(c)}>Preview</Button>
							{#if !c.subscribed}
								<form method="POST" action="/discover?/follow" class="contents">
									<input type="hidden" name="url" value={c.url} />
									<input type="hidden" name="routePath" value={c.routePath} />
									<input
										type="hidden"
										name="prefill"
										value={c.prefill ? JSON.stringify(c.prefill) : ''}
									/>
									<input type="hidden" name="collection" value={followCollection()} />
									<Button variant="default" size="sm" type="submit">Follow</Button>
								</form>
							{/if}
						{:else if c.docs}
							<Button variant="outline" size="sm" href={c.docs} target="_blank" rel="noopener">
								Route docs
							</Button>
						{/if}
					</Item.Actions>
				</Item.Root>
			{/each}
		</div>

		{#if (data.totalPages ?? 1) > 1}
			{#key data.page}
				<Pagination.Root
					count={data.total}
					perPage={data.pageSize ?? 10}
					page={data.page ?? 1}
					siblingCount={1}
					onPageChange={(p) => {
						void goto(pageHref(p));
					}}
				>
					{#snippet children({ pages, currentPage })}
						<Pagination.Content>
							<Pagination.Item>
								<Pagination.Previous />
							</Pagination.Item>
							{#each pages as p (p.key)}
								<Pagination.Item>
									{#if p.type === 'ellipsis'}
										<Pagination.Ellipsis />
									{:else}
										<Pagination.Link page={p} isActive={p.value === currentPage} />
									{/if}
								</Pagination.Item>
							{/each}
							<Pagination.Item>
								<Pagination.Next />
							</Pagination.Item>
						</Pagination.Content>
					{/snippet}
				</Pagination.Root>
			{/key}
		{/if}
	{/if}
</div>
