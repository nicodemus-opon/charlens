<script lang="ts">
	import * as Command from '$lib/components/ui/command/index.js';
	import { Kbd } from '$lib/components/ui/kbd/index.js';
	import type { CollectionRow } from '$lib/collections.js';
	import {
		articlePaletteItems,
		collectionHref,
		feedHref,
		matchesQuery,
		rankPaletteItems,
		smartViewHref,
		tagHref,
		type Matchable,
		type PaletteArticle,
		type PaletteItem
	} from '$lib/palette.js';
	import {
		Bookmark,
		Compass,
		FileText,
		Folder,
		Hash,
		Newspaper,
		Plus,
		RefreshCw,
		Rss,
		Sparkles
	} from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	interface PaletteFeed {
		id: number;
		title: string;
		unread: number;
	}

	interface PaletteTag {
		id: number;
		name: string;
		count: number;
	}

	/** Rows that do something instead of navigating. */
	interface PaletteAction extends Matchable {
		id: string;
		run: () => void;
	}

	let {
		open = $bindable(false),
		feeds = [],
		collections = [],
		tags = [],
		onAddContent,
		onRefreshFeeds
	}: {
		open?: boolean;
		feeds?: PaletteFeed[];
		collections?: CollectionRow[];
		tags?: PaletteTag[];
		onAddContent?: () => void;
		onRefreshFeeds?: () => void;
	} = $props();

	/** Below this the palette stays client-side: too short a query to hit the API. */
	const MIN_QUERY_LENGTH = 2;
	const SEARCH_DEBOUNCE_MS = 200;
	const ARTICLE_LIMIT = 6;
	/** Per-group cap, so every group stays scannable. */
	const GROUP_LIMIT = 5;

	let query = $state('');
	let articles = $state<PaletteArticle[]>([]);
	/** Query the current `articles` belong to, so stale rows never render mid-typing. */
	let articlesQuery = $state('');
	let loading = $state(false);
	/** Action waiting for the dialog to finish closing (see `runAction`). */
	let pendingAction: (() => void) | null = null;
	let controller: AbortController | null = null;

	const trimmed = $derived(query.trim());

	const articleItems = $derived(articlesQuery === trimmed ? articlePaletteItems(articles) : []);

	const tagItems = $derived(
		rankPaletteItems(
			tags.map((tag): PaletteItem => ({
				id: `tag-${tag.id}`,
				label: `#${tag.name}`,
				hint: `${tag.count} ${tag.count === 1 ? 'story' : 'stories'}`,
				href: tagHref(tag.id)
			})),
			trimmed,
			GROUP_LIMIT
		)
	);

	const collectionItems = $derived(
		rankPaletteItems(
			collections
				.filter((collection) => collection.kind !== 'smart')
				.map((collection): PaletteItem => ({
					id: `collection-${collection.id}`,
					label: collection.name,
					hint: `${collection.feedCount} ${collection.feedCount === 1 ? 'feed' : 'feeds'}`,
					href: collectionHref(collection.id)
				})),
			trimmed,
			GROUP_LIMIT
		)
	);

	const smartViewItems = $derived(
		rankPaletteItems(
			collections
				.filter((collection) => collection.kind === 'smart')
				.map((collection): PaletteItem => ({
					id: `smart-${collection.id}`,
					label: collection.name,
					hint: `${collection.unread} unread`,
					keywords: ['smart view'],
					href: smartViewHref(collection.id)
				})),
			trimmed,
			GROUP_LIMIT
		)
	);

	const feedItems = $derived(
		rankPaletteItems(
			feeds.map((feed): PaletteItem => ({
				id: `feed-${feed.id}`,
				label: feed.title,
				hint: `${feed.unread} unread`,
				keywords: ['feed'],
				href: feedHref(feed.id)
			})),
			trimmed,
			GROUP_LIMIT
		)
	);

	// Fixed destinations and actions are literal rows, so each keeps its own icon.
	const todayRow: PaletteItem = {
		id: 'go-today',
		label: 'Today',
		hint: "What's new",
		keywords: ['inbox', 'unread'],
		href: '/?filter=today'
	};
	const savedRow: PaletteItem = {
		id: 'go-saved',
		label: 'Read later',
		hint: 'Saved stories',
		keywords: ['bookmarks', 'saved'],
		href: '/?filter=saved'
	};
	const recommendedRow: PaletteItem = {
		id: 'go-recommended',
		label: 'Recommended',
		hint: 'Picked for you',
		keywords: ['for you', 'picks'],
		href: '/?filter=recommended'
	};
	const allRow: PaletteItem = {
		id: 'go-all',
		label: 'All stories',
		hint: 'Everything',
		keywords: ['archive'],
		href: '/?filter=all'
	};
	const addAction: PaletteAction = {
		id: 'action-add',
		label: 'Add content',
		hint: 'Feed or RSSHub route',
		keywords: ['subscribe', 'new feed'],
		run: () => onAddContent?.()
	};
	const refreshAction: PaletteAction = {
		id: 'action-refresh',
		label: 'Refresh feeds',
		hint: 'Fetch new stories',
		keywords: ['sync', 'update'],
		run: () => onRefreshFeeds?.()
	};

	function visible(item: Matchable): boolean {
		return matchesQuery(item, trimmed);
	}

	/** ⌘K / Ctrl+K toggles from anywhere in the app. */
	function handleKeydown(event: KeyboardEvent) {
		if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
		event.preventDefault();
		open = !open;
	}

	function handleOpenChange(next: boolean) {
		if (!next) query = '';
	}

	/** Actions open another dialog, so they wait until this one is fully gone. */
	function runAction(action: () => void) {
		pendingAction = action;
		open = false;
	}

	function handleOpenChangeComplete(next: boolean) {
		if (next) return;
		const action = pendingAction;
		pendingAction = null;
		action?.();
	}

	function closePalette() {
		open = false;
	}

	// Every open starts clean. Results linger through the closing animation
	// instead of flashing empty.
	$effect(() => {
		if (!open) return;
		query = '';
		articles = [];
		articlesQuery = '';
		loading = false;
		controller?.abort();
		controller = null;
	});

	// Articles come from the server (the layout already ships tags, collections
	// and feeds, so those groups filter locally).
	$effect(() => {
		const q = trimmed;
		if (!open || q.length < MIN_QUERY_LENGTH) {
			loading = false;
			return;
		}
		loading = true;
		const timer = setTimeout(() => {
			const current = new AbortController();
			controller = current;
			fetch(`/api/articles/search?q=${encodeURIComponent(q)}&limit=${ARTICLE_LIMIT}`, {
				signal: current.signal
			})
				.then((response) => {
					if (!response.ok) throw new Error(`search failed (${response.status})`);
					return response.json() as Promise<{ articles?: PaletteArticle[] }>;
				})
				.then((body) => {
					articles = body.articles ?? [];
					articlesQuery = q;
				})
				.catch((error: unknown) => {
					if (current.signal.aborted) return;
					console.error('palette article search failed', error);
					articles = [];
					articlesQuery = q;
				})
				.finally(() => {
					if (current.signal.aborted) return;
					loading = false;
				});
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			controller?.abort();
			controller = null;
		};
	});
</script>

<svelte:document onkeydown={handleKeydown} />

{#snippet row(item: PaletteItem, icon: Snippet)}
	<Command.LinkItem value={item.id} href={item.href} onSelect={closePalette}>
		{@render icon()}
		<span class="min-w-0 flex-1 truncate">{item.label}</span>
		{#if item.hint}
			<span class="ml-auto shrink-0 text-xs text-muted-foreground">{item.hint}</span>
		{/if}
	</Command.LinkItem>
{/snippet}

{#snippet articleIcon()}
	<FileText />
{/snippet}
{#snippet tagIcon()}
	<Hash />
{/snippet}
{#snippet collectionIcon()}
	<Folder />
{/snippet}
{#snippet smartViewIcon()}
	<Sparkles />
{/snippet}
{#snippet feedIcon()}
	<Rss />
{/snippet}
{#snippet todayIcon()}
	<Newspaper />
{/snippet}
{#snippet bookmarkIcon()}
	<Bookmark />
{/snippet}
{#snippet compassIcon()}
	<Compass />
{/snippet}

<Command.Dialog
	bind:open
	shouldFilter={false}
	title="Search charlens"
	description="Search articles, tags, collections and feeds"
	onOpenChange={handleOpenChange}
	onOpenChangeComplete={handleOpenChangeComplete}
>
	<Command.Input placeholder="Search articles, tags, collections…" bind:value={query} />

	<Command.List>
		{#if loading}
			<Command.Loading>
				<p class="py-4 text-center text-sm text-muted-foreground">Searching…</p>
			</Command.Loading>
		{/if}

		{#if articleItems.length > 0}
			<Command.Group heading="Articles">
				{#each articleItems as item (item.id)}
					{@render row(item, articleIcon)}
				{/each}
			</Command.Group>
			<Command.Separator />
		{/if}

		{#if visible(todayRow) || visible(savedRow) || visible(recommendedRow) || visible(allRow)}
			<Command.Group heading="Go to">
				{#if visible(todayRow)}
					{@render row(todayRow, todayIcon)}
				{/if}
				{#if visible(savedRow)}
					{@render row(savedRow, bookmarkIcon)}
				{/if}
				{#if visible(recommendedRow)}
					{@render row(recommendedRow, compassIcon)}
				{/if}
				{#if visible(allRow)}
					{@render row(allRow, articleIcon)}
				{/if}
			</Command.Group>
			<Command.Separator />
		{/if}

		{#if tagItems.length > 0}
			<Command.Group heading="Tags">
				{#each tagItems as item (item.id)}
					{@render row(item, tagIcon)}
				{/each}
			</Command.Group>
			<Command.Separator />
		{/if}

		{#if collectionItems.length > 0}
			<Command.Group heading="Collections">
				{#each collectionItems as item (item.id)}
					{@render row(item, collectionIcon)}
				{/each}
			</Command.Group>
			<Command.Separator />
		{/if}

		{#if smartViewItems.length > 0}
			<Command.Group heading="Smart views">
				{#each smartViewItems as item (item.id)}
					{@render row(item, smartViewIcon)}
				{/each}
			</Command.Group>
			<Command.Separator />
		{/if}

		{#if feedItems.length > 0}
			<Command.Group heading="Feeds">
				{#each feedItems as item (item.id)}
					{@render row(item, feedIcon)}
				{/each}
			</Command.Group>
			<Command.Separator />
		{/if}

		{#if visible(addAction) || visible(refreshAction)}
			<Command.Group heading="Actions">
				{#if visible(addAction)}
					<Command.Item value={addAction.id} onSelect={() => runAction(addAction.run)}>
						<Plus />
						<span class="min-w-0 flex-1 truncate">{addAction.label}</span>
						<span class="ml-auto shrink-0 text-xs text-muted-foreground">{addAction.hint}</span>
					</Command.Item>
				{/if}
				{#if visible(refreshAction)}
					<Command.Item value={refreshAction.id} onSelect={() => runAction(refreshAction.run)}>
						<RefreshCw />
						<span class="min-w-0 flex-1 truncate">{refreshAction.label}</span>
						<span class="ml-auto shrink-0 text-xs text-muted-foreground">{refreshAction.hint}</span>
					</Command.Item>
				{/if}
			</Command.Group>
		{/if}

		{#if !loading}
			<Command.Empty>
				<p class="py-6 text-center text-sm text-muted-foreground">No matches for “{trimmed}”.</p>
			</Command.Empty>
		{/if}
	</Command.List>

	<div class="flex items-center gap-4 border-t border-border p-2 text-xs text-muted-foreground">
		<span class="flex items-center gap-1.5">
			<Kbd>↑</Kbd>
			<Kbd>↓</Kbd>
			Navigate
		</span>
		<span class="flex items-center gap-1.5">
			<Kbd>↵</Kbd>
			Open
		</span>
		<span class="ml-auto flex items-center gap-1.5">
			<Kbd>Esc</Kbd>
			Close
		</span>
	</div>
</Command.Dialog>
