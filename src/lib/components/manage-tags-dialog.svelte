<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Trash2 } from '@lucide/svelte';

	let {
		open = $bindable(false),
		tags = []
	}: {
		open?: boolean;
		tags?: { id: number; name: string; count: number }[];
	} = $props();

	// Which tag row is being renamed (inline input) — null means plain list.
	let editingId = $state<number | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		if (open) {
			editingId = null;
			error = null;
		}
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Manage tags</Dialog.Title>
			<Dialog.Description
				>Rename or delete tags. Deleting removes the tag everywhere.</Dialog.Description
			>
		</Dialog.Header>
		<div class="flex flex-col gap-2 py-2">
			{#if tags.length === 0}
				<p class="text-sm text-muted-foreground">No tags yet.</p>
			{:else}
				{#each tags as t (t.id)}
					<div class="flex items-center gap-2">
						{#if editingId === t.id}
							<form
								class="flex min-w-0 flex-1 items-center gap-2"
								method="POST"
								action="/?/renameTag"
								use:enhance={() => {
									error = null;
									return async ({ result, update }) => {
										if (result.type === 'failure') {
											error = String(
												(result.data as Record<string, unknown>)?.message ?? 'Could not rename tag'
											);
										} else {
											editingId = null;
										}
										await update();
									};
								}}
							>
								<input type="hidden" name="id" value={t.id} />
								<Input name="name" value={t.name} class="min-w-0 flex-1" autocomplete="off" />
								<Button type="submit" size="sm">Save</Button>
							</form>
						{:else}
							<button
								type="button"
								class="min-w-0 flex-1 truncate text-left text-sm"
								onclick={() => (editingId = t.id)}
								title="Rename"
							>
								{t.name}
							</button>
						{/if}
						<span class="shrink-0 text-xs text-muted-foreground">{t.count}</span>
						<form method="POST" action="/?/deleteTag" use:enhance>
							<input type="hidden" name="id" value={t.id} />
							<Button variant="ghost" size="icon-sm" type="submit" aria-label="Delete tag">
								<Trash2 />
							</Button>
						</form>
					</div>
				{/each}
			{/if}
			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)} type="button">Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
