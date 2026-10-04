<script lang="ts">
	import ArticleImage from '$lib/components/article-image.svelte';
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Item from '$lib/components/ui/item/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { goto } from '$app/navigation';
	import { List, Plus } from '@lucide/svelte';
	import { faviconUrl } from '$lib/feed-icon.js';

	let { data } = $props();

	let collection = $state('General');
	let customCollection = $state('');
	let isNewCollection = $state(false);

	const suggestions = $derived(
		[...new Set([...(data.collections ?? []).map((c) => c.name), 'General'])]
			.map((c) => c.trim())
			.filter(Boolean)
			.sort((a, b) => a.localeCompare(b))
	);

	$effect(() => {
		if (!suggestions.includes(collection)) collection = 'General';
	});

	function followCollection() {
		return isNewCollection && customCollection.trim() ? customCollection.trim() : collection;
	}

	// Back returns to the list the user came from (search results, collection,
	// …), not the empty Discover landing. Direct opens with no history fall
	// back to Discover.
	function goBack() {
		if (window.history.length > 1) window.history.back();
		else void goto('/discover');
	}

	const icon = $derived(faviconUrl(data.siteUrl || data.resolvedUrl, data.resolvedUrl));

	function initialFor(title: string) {
		const src = (title || '?').trim();
		return (src[0] ?? '?').toUpperCase();
	}

	/** Stable numeric seed for generated covers (no db id on preview rows). */
	function seedId(link: string) {
		let h = 0;
		for (let i = 0; i < link.length; i++) h = (h * 31 + link.charCodeAt(i)) | 0;
		return Math.abs(h);
	}

	function dateLabel(iso: string | null) {
		if (!iso) return '';
		try {
			return new Date(iso).toLocaleDateString(undefined, {
				year: 'numeric',
				month: 'short',
				day: 'numeric'
			});
		} catch {
			return '';
		}
	}
</script>

<svelte:head>
	<title>{data.title ? `${data.title} ` : ''}Preview charlens</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8">
	<Button variant="ghost" size="sm" onclick={goBack} class="w-fit">← Back to Discover</Button>

	{#if data.error && !data.verified && data.items.length === 0}
		<Card.Root class="w-full">
			<Card.Header>
				<Card.Title>Could not preview this feed</Card.Title>
				<Card.Description>
					<span class="font-mono text-xs">{data.feedUrl}</span>
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<p class="text-sm text-muted-foreground">{data.error}</p>
			</Card.Content>
			<Card.Footer>
				<form method="POST" action="/discover?/follow" class="contents">
					<input type="hidden" name="url" value={data.resolvedUrl || data.feedUrl} />
					<input type="hidden" name="collection" value={followCollection()} />
					<Button variant="default" size="sm" type="submit">Follow anyway</Button>
				</form>
			</Card.Footer>
		</Card.Root>
	{:else}
		<div class="flex items-start gap-3">
			<Avatar.Root size="sm" variant="feed" class="hidden shrink-0 sm:flex">
				{#if icon}
					<Avatar.Image src={icon} alt={data.title} variant="feed" />
				{/if}
				<Avatar.Fallback variant="feed">{initialFor(data.title || 'F')}</Avatar.Fallback>
			</Avatar.Root>
			<div class="flex min-w-0 flex-1 flex-col gap-1">
				<h1 class="text-2xl font-bold text-foreground">{data.title || 'Feed preview'}</h1>
				{#if data.siteUrl}
					<a
						href={data.siteUrl}
						target="_blank"
						rel="noopener"
						class="text-sm text-muted-foreground underline-offset-4 hover:underline"
					>
						{data.siteUrl}
					</a>
				{/if}
			</div>
		</div>

		<form method="POST" action="/discover?/follow" class="flex flex-col gap-2">
			<Label for="preview-collection">Add to collection</Label>
			{#if isNewCollection}
				<div class="flex gap-2">
					<Input
						id="preview-collection"
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
						<Select.Trigger id="preview-collection" size="sm" class="w-full">
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
			<input type="hidden" name="url" value={data.resolvedUrl || data.feedUrl} />
			<input type="hidden" name="collection" value={followCollection()} />
			<Button variant="default" size="sm" type="submit" class="w-fit">Follow feed</Button>
		</form>

		{#if data.error}
			<p class="text-sm text-muted-foreground">{data.error}</p>
		{/if}

		<Separator />

		<div class="flex flex-col gap-3">
			<h2 class="text-sm font-semibold text-foreground">
				Recent stories{data.items.length > 0 ? ` (${data.items.length})` : ''}
			</h2>
			{#if data.items.length === 0}
				<p class="text-sm text-muted-foreground">No stories fetched yet.</p>
			{/if}
			{#each data.items as item (item.link + item.title)}
				<Item.Root variant="outline">
					<ArticleImage
						seed={{ id: seedId(item.link), feedTitle: data.title ?? '', title: item.title }}
						src={item.imageUrl}
						alt=""
						minCoverWidth={100}
						class="size-14 shrink-0 rounded-lg max-sm:hidden sm:size-16"
					/>
					<Item.Content class="min-w-0 flex-1">
						<Item.Title class="w-full min-w-0">
							<span class="min-w-0 flex-1 truncate">{item.title}</span>
						</Item.Title>
						<Item.Description>
							{#if item.author}<span>{item.author}</span>{/if}
							{#if item.author && item.publishedAt}<span>{' '}</span>{/if}
							{#if item.publishedAt}<span>{dateLabel(item.publishedAt)}</span>{/if}
						</Item.Description>
						{#if item.excerpt}
							<p class="line-clamp-2 text-sm text-muted-foreground">{item.excerpt}</p>
						{/if}
					</Item.Content>
					<Item.Actions class="ml-auto shrink-0">
						<Button variant="outline" size="sm" href={item.link} target="_blank" rel="noopener">
							Open story
						</Button>
					</Item.Actions>
				</Item.Root>
			{/each}
		</div>
	{/if}
</div>
