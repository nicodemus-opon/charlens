<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Select from '$lib/components/ui/select/index.js';

	let {
		open = $bindable(false),
		existingCollections = [],
		/** @deprecated Use existingCollections. */
		existingCategories = []
	}: {
		open?: boolean;
		existingCollections?: string[];
		existingCategories?: string[];
	} = $props();

	let url = $state('');
	let collection = $state('General');
	let customCollection = $state('');
	let isNewCollection = $state(false);
	let error = $state<string | null>(null);
	let busy = $state(false);

	// Suggestions come only from this user's own collections — nothing global.
	const suggestions = $derived(
		[
			...new Set(
				[...existingCollections, ...existingCategories, 'General']
					.map((c) => c.trim())
					.filter(Boolean)
			)
		].sort((a, b) => a.localeCompare(b))
	);

	// Keep the select on a known value; reset the new-collection form when closed.
	$effect(() => {
		if (!open) {
			isNewCollection = false;
			customCollection = '';
			error = null;
		}
		if (!suggestions.includes(collection)) collection = 'General';
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Add content</Dialog.Title>
			<Dialog.Description>Paste a link — a feed, a site, a channel, anything.</Dialog.Description>
		</Dialog.Header>
		<form
			method="POST"
			action="/?/addFeed"
			use:enhance={() => {
				busy = true;
				error = null;
				// Optimistic: close right away. The server only validates the URL
				// and inserts a placeholder row; discovery/scraping runs in the
				// background and the feed's items appear once fetched.
				open = false;
				return async ({ result, update }) => {
					busy = false;
					if (result.type === 'failure') {
						// Re-open with the error (e.g. malformed URL).
						open = true;
						error = String(
							(result.data as Record<string, unknown>)?.message ?? 'Could not add feed'
						);
					} else if (result.type === 'redirect' || result.type === 'success') {
						url = '';
						customCollection = '';
						isNewCollection = false;
					}
					await update();
				};
			}}
		>
			<div class="flex flex-col gap-3 py-2">
				<Input name="url" type="url" required placeholder="https://example.com" bind:value={url} />
				<div class="flex flex-col gap-2">
					<Label for="feed-collection">Collection</Label>
					{#if isNewCollection}
						<Input
							id="feed-collection"
							name="collection"
							placeholder="New collection name"
							autocomplete="off"
							bind:value={customCollection}
						/>
						<Button
							variant="ghost"
							size="sm"
							class="w-fit"
							type="button"
							onclick={() => {
								isNewCollection = false;
								customCollection = '';
							}}
						>
							Choose an existing collection
						</Button>
					{:else}
						<Select.Root type="single" name="collection" bind:value={collection}>
							<Select.Trigger id="feed-collection" class="w-full">
								<Select.Value placeholder="Select a collection" />
							</Select.Trigger>
							<Select.Content>
								{#each suggestions as c (c)}
									<Select.Item value={c}>{c}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
						<Button
							variant="ghost"
							size="sm"
							class="w-fit"
							type="button"
							onclick={() => (isNewCollection = true)}
						>
							New collection…
						</Button>
					{/if}
				</div>
				{#if error}
					<p class="text-sm text-destructive">{error}</p>
				{/if}
			</div>
			<Dialog.Footer>
				<Button variant="outline" onclick={() => (open = false)} type="button">Cancel</Button>
				<Button
					type="submit"
					disabled={busy || !url.trim() || (isNewCollection && !customCollection.trim())}
				>
					{busy ? 'Adding…' : 'Follow feed'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
