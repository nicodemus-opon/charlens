<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { afterNavigate } from '$app/navigation';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import * as Collapsible from '$lib/components/ui/collapsible/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import {
		Bookmark,
		ChevronRight,
		Compass,
		Newspaper,
		Plus,
		Search,
		Sparkles
	} from '@lucide/svelte';
	import type { CollectionRow } from '$lib/collections';
	import { feedDisplayIcon } from '$lib/feed-icon';
	import { mobileActions } from '$lib/mobile-actions.svelte.js';
	import AddFeedDialog from './add-feed-dialog.svelte';
	import CommandPalette from './command-palette.svelte';
	import ManageCollectionsDialog from './manage-collections-dialog.svelte';
	import SmartViewBuilderDialog from './smart-view-builder-dialog.svelte';
	import NavUser from './nav-user.svelte';

	interface FeedRow {
		id: number;
		url: string;
		title: string;
		siteUrl: string | null;
		imageUrl: string | null;
		/** @deprecated Use collectionName. */
		category: string;
		collectionId: number | null;
		collectionName: string;
		unread: number;
		total: number;
	}

	interface TagRow {
		id: number;
		name: string;
		count: number;
	}

	type SidebarUser = {
		name: string;
		email: string;
		avatar: string | null;
	};

	let {
		feeds = [],
		collections = [],
		tags = [],
		counts = { today: 0 },
		user = null
	}: {
		feeds: FeedRow[];
		collections?: CollectionRow[];
		tags?: TagRow[];
		counts: { today: number; recommended?: number };
		user?: SidebarUser | null;
	} = $props();

	let manageOpen = $state(false);
	let smartOpen = $state(false);
	let refreshForm = $state<HTMLFormElement | null>(null);

	const sidebar = Sidebar.useSidebar();

	/** The icon rail hides all labels, so the header and feed list render differently. */
	const isIconRail = $derived(sidebar.state === 'collapsed' && !sidebar.isMobile);

	const filter = $derived($page.url.searchParams.get('filter') ?? 'today');
	const activeFeed = $derived($page.url.searchParams.get('feed'));
	const activeCollection = $derived($page.url.searchParams.get('collection'));
	const activeView = $derived($page.url.searchParams.get('view'));

	const manualCollections = $derived(collections.filter((c) => c.kind !== 'smart'));
	const smartViews = $derived(collections.filter((c) => c.kind === 'smart'));

	/**
	 * Manual feeds grouped by collection, ordered by the collections list
	 * (position, name). Feeds whose collection is unknown fall back to a
	 * group derived from their own collectionName.
	 */
	const collectionGroups = $derived(() => {
		const byId = new Map<number, FeedRow[]>();
		for (const f of feeds) {
			if (f.collectionId == null) continue;
			const list = byId.get(f.collectionId) ?? [];
			list.push(f);
			byId.set(f.collectionId, list);
		}
		const groups: { id: number | null; name: string; items: FeedRow[] }[] = [];
		for (const c of manualCollections) {
			groups.push({ id: c.id, name: c.name, items: byId.get(c.id) ?? [] });
			byId.delete(c.id);
		}
		const leftovers = new Map<string, FeedRow[]>();
		for (const f of feeds) {
			if (f.collectionId != null) continue;
			const list = leftovers.get(f.collectionName) ?? [];
			list.push(f);
			leftovers.set(f.collectionName, list);
		}
		for (const [name, items] of leftovers) groups.push({ id: null, name, items });
		return groups;
	});

	const userCollections = $derived([
		...new Set([...manualCollections.map((c) => c.name), ...feeds.map((f) => f.collectionName)])
	]);

	/** Collection groups start open; the chevron rotates and the feed list collapses on toggle. */
	let collapsedCollections = $state<Record<string, boolean>>({});

	function href(params: Record<string, string | null>) {
		const url = new URL($page.url);
		// Sidebar navigation always moves to a single scope (feed, collection,
		// smart view or tag) — a tag filter never carries over unless passed.
		if (!('tag' in params)) url.searchParams.delete('tag');
		for (const [k, v] of Object.entries(params)) {
			if (v === null) url.searchParams.delete(k);
			else url.searchParams.set(k, v);
		}
		url.searchParams.delete('article');
		return `${url.pathname}?${url.searchParams.toString()}`;
	}

	/**
	 * Clicking Recommended gently refreshes: the plain href would be
	 * identical when already on ?filter=recommended (a SvelteKit no-op with
	 * no load re-run), and ranking is daily-deterministic without a seed.
	 * A fresh `shuffle` param forces both a navigation and a small
	 * exploration mix; search text and deep-shuffle mode never carry over.
	 */
	function goRecommended(e: MouseEvent) {
		e.preventDefault();
		const url = new URL($page.url);
		url.searchParams.set('filter', 'recommended');
		url.searchParams.delete('feed');
		url.searchParams.delete('collection');
		url.searchParams.delete('view');
		url.searchParams.delete('tag');
		url.searchParams.delete('q');
		url.searchParams.delete('article');
		url.searchParams.delete('deep');
		url.searchParams.set('shuffle', String(Date.now()));
		goto(`${url.pathname}?${url.searchParams.toString()}`, { keepFocus: true });
	}

	/** Menu items cannot post forms, so the footer menu submits this hidden form. */
	function refreshFeeds() {
		refreshForm?.requestSubmit();
	}

	// Picking a destination on a phone dismisses the drawer — otherwise the
	// sheet stays over the freshly loaded list.
	afterNavigate(() => {
		if (sidebar.isMobile && sidebar.openMobile) sidebar.setOpenMobile(false);
	});
</script>

{#snippet brandMark()}
	<img src="/logo.png" alt="charlens logo" class="size-7 rounded-full" />
{/snippet}

{#snippet feedItem(f: FeedRow)}
	{@const icon = feedDisplayIcon(f)}
	<Sidebar.MenuItem>
		<Sidebar.MenuButton isActive={activeFeed === String(f.id)} tooltipContent={f.title}>
			{#snippet child({ props })}
				<a
					href={href({ filter: 'all', feed: String(f.id), collection: null, view: null })}
					{...props}
				>
					<Avatar.Root class="size-5 shrink-0" variant="feed">
						{#if icon}
							<Avatar.Image src={icon} alt={f.title} variant="feed" />
						{/if}
						<Avatar.Fallback variant="feed">{f.title.slice(0, 2).toUpperCase()}</Avatar.Fallback>
					</Avatar.Root>
					<span class={f.unread > 0 ? 'mr-6 min-w-0 flex-1 truncate' : 'min-w-0 flex-1 truncate'}>
						{f.title}
					</span>
				</a>
			{/snippet}
		</Sidebar.MenuButton>
		{#if f.unread > 0}
			<Sidebar.MenuBadge>{f.unread}</Sidebar.MenuBadge>
		{/if}
	</Sidebar.MenuItem>
{/snippet}

<Sidebar.Root collapsible="icon">
	<Sidebar.Header>
		{#if isIconRail}
			<div class="flex flex-col items-center gap-2">
				<a
					href={href({ filter: 'today', feed: null, collection: null, view: null })}
					aria-label="charlens"
				>
					{@render brandMark()}
				</a>
				<Sidebar.Trigger class="mx-auto" />
				<Button
					variant="outline"
					size="icon-sm"
					aria-label="Add content"
					onclick={() => (mobileActions.addOpen = true)}
				>
					<Plus />
				</Button>
				<Button
					variant="outline"
					size="icon-sm"
					aria-label="Search (⌘K)"
					onclick={() => (mobileActions.paletteOpen = true)}
				>
					<Search />
				</Button>
			</div>
		{:else}
			<div class="flex items-center justify-between gap-2 px-2 py-1">
				<a
					href={href({ filter: 'today', feed: null, collection: null, view: null })}
					class="flex items-center gap-2"
				>
					{@render brandMark()}
					<span class="text-base font-semibold text-foreground">charlens</span>
				</a>
				<Sidebar.Trigger />
			</div>
			<div class="px-2 pt-1">
				<Button
					variant="outline"
					size="sm"
					class="w-full"
					onclick={() => (mobileActions.addOpen = true)}
				>
					<Plus /> Add content
				</Button>
			</div>
		{/if}
	</Sidebar.Header>
	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
							isActive={filter === 'today' && !activeFeed && !activeView}
							tooltipContent="Today"
						>
							{#snippet child({ props })}
								<a
									href={href({ filter: 'today', feed: null, collection: null, view: null })}
									{...props}
								>
									<Newspaper />
									<span class={counts.today > 0 ? 'mr-6 min-w-0 flex-1 truncate' : ''}>
										Today
									</span>
								</a>
							{/snippet}
						</Sidebar.MenuButton>
						{#if counts.today > 0}
							<Sidebar.MenuBadge>{counts.today}</Sidebar.MenuBadge>
						{/if}
					</Sidebar.MenuItem>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
							isActive={filter === 'saved' && !activeView}
							tooltipContent="Read later"
						>
							{#snippet child({ props })}
								<a
									href={href({ filter: 'saved', feed: null, collection: null, view: null })}
									{...props}
								>
									<Bookmark />
									<span>Read later</span>
								</a>
							{/snippet}
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
							isActive={filter === 'recommended' && !activeFeed && !activeView}
							tooltipContent="Recommended"
						>
							{#snippet child({ props })}
								{@const tooltipClick = (props as { onclick?: (e: MouseEvent) => void }).onclick}
								<a
									href={href({
										filter: 'recommended',
										feed: null,
										collection: null,
										view: null
									})}
									{...props}
									onclick={(e) => {
										tooltipClick?.(e);
										goRecommended(e);
									}}
								>
									<Compass />
									<span
										class={(counts.recommended ?? 0) > 0
											? 'mr-6 min-w-0 flex-1 truncate'
											: 'min-w-0 flex-1 truncate'}
									>
										Recommended
									</span>
								</a>
							{/snippet}
						</Sidebar.MenuButton>
						{#if (counts.recommended ?? 0) > 0}
							<Sidebar.MenuBadge>{counts.recommended}</Sidebar.MenuBadge>
						{/if}
					</Sidebar.MenuItem>
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
		{#if isIconRail}
			<!-- Icon rail: the collections would be chevrons only, so list every feed as an icon. -->
			<Sidebar.Group>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each feeds as f (f.id)}
							{@render feedItem(f)}
						{/each}
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		{:else}
			{#if smartViews.length > 0}
				<Sidebar.Group>
					<Sidebar.GroupLabel>Smart views</Sidebar.GroupLabel>
					<Sidebar.GroupContent>
						<Sidebar.Menu>
							{#each smartViews as v (v.id)}
								<Sidebar.MenuItem>
									<Sidebar.MenuButton
										isActive={activeView === String(v.id)}
										tooltipContent={v.name}
									>
										{#snippet child({ props })}
											<a
												href={href({
													view: String(v.id),
													feed: null,
													collection: null,
													filter: null
												})}
												{...props}
											>
												<Sparkles />
												<span
													class={v.unread > 0
														? 'mr-6 min-w-0 flex-1 truncate'
														: 'min-w-0 flex-1 truncate'}
												>
													{v.name}
												</span>
											</a>
										{/snippet}
									</Sidebar.MenuButton>
									{#if v.unread > 0}
										<Sidebar.MenuBadge>{v.unread}</Sidebar.MenuBadge>
									{/if}
								</Sidebar.MenuItem>
							{/each}
						</Sidebar.Menu>
					</Sidebar.GroupContent>
				</Sidebar.Group>
			{/if}
			<Sidebar.Group>
				<Sidebar.GroupLabel>Collections</Sidebar.GroupLabel>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Sidebar.GroupAction
								{...props}
								title="Collection options"
								aria-label="Collection options"
							>
								<Plus />
								<span class="sr-only">Collection options</span>
							</Sidebar.GroupAction>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content side="right" align="start" class="w-56 whitespace-nowrap">
						<DropdownMenu.Item onSelect={() => (smartOpen = true)}>
							New smart view
						</DropdownMenu.Item>
						<DropdownMenu.Item onSelect={() => (manageOpen = true)}>
							Manage collections
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
				<Sidebar.GroupContent>
					{#each collectionGroups() as group (group.id ?? group.name)}
						<Collapsible.Root
							class="group/collapsible"
							open={!collapsedCollections[group.name]}
							onOpenChange={(open) => (collapsedCollections[group.name] = !open)}
						>
							<Collapsible.Trigger>
								{#snippet child({ props })}
									<div class="flex w-full items-center gap-1">
										{#if group.id != null}
											<Sidebar.MenuButton
												isActive={activeCollection === String(group.id)}
												class="min-w-0 flex-1"
											>
												{#snippet child({ props: menuProps })}
													<a
														href={href({
															filter: 'all',
															collection: String(group.id),
															feed: null,
															view: null
														})}
														{...menuProps}
													>
														<span class="truncate">{group.name}</span>
													</a>
												{/snippet}
											</Sidebar.MenuButton>
										{:else}
											<Sidebar.MenuButton class="flex-1">
												<span class="truncate">{group.name}</span>
											</Sidebar.MenuButton>
										{/if}
										<Sidebar.MenuButton
											{...props}
											class="w-auto shrink-0"
											aria-label="Toggle collection"
										>
											<ChevronRight
												class="transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90"
											/>
										</Sidebar.MenuButton>
									</div>
								{/snippet}
							</Collapsible.Trigger>
							<Collapsible.Content>
								<Sidebar.Menu>
									{#each group.items as f (f.id)}
										{@render feedItem(f)}
									{/each}
								</Sidebar.Menu>
							</Collapsible.Content>
						</Collapsible.Root>
					{/each}
					{#if feeds.length === 0}
						<div class="px-4 py-2">
							<p class="text-sm text-muted-foreground">
								No feeds yet. Add your first feed to get started.
							</p>
						</div>
					{/if}
				</Sidebar.GroupContent>
			</Sidebar.Group>
		{/if}
	</Sidebar.Content>
	<Sidebar.Footer>
		<NavUser
			{user}
			feedsCount={feeds.length}
			onAddContent={() => (mobileActions.addOpen = true)}
			onRefreshFeeds={refreshFeeds}
		/>
	</Sidebar.Footer>
</Sidebar.Root>

<form method="POST" action="/?/refresh" use:enhance class="hidden" bind:this={refreshForm}></form>

<CommandPalette
	bind:open={mobileActions.paletteOpen}
	{feeds}
	{collections}
	{tags}
	onAddContent={() => (mobileActions.addOpen = true)}
	onRefreshFeeds={refreshFeeds}
/>

<AddFeedDialog bind:open={mobileActions.addOpen} existingCollections={userCollections} />
<ManageCollectionsDialog
	bind:open={manageOpen}
	collections={manualCollections}
	feeds={feeds.map((f) => ({
		id: f.id,
		title: f.title,
		collectionId: f.collectionId
	}))}
/>
<SmartViewBuilderDialog
	bind:open={smartOpen}
	feeds={feeds.map((f) => ({ id: f.id, title: f.title }))}
	{tags}
/>
