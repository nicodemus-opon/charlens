<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';

	let {
		open = $bindable(false),
		collectionId = null,
		initialName = ''
	}: {
		open?: boolean;
		collectionId?: number | null;
		initialName?: string;
	} = $props();

	let name = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);

	const isRename = $derived(collectionId != null);

	// Refresh the input whenever the dialog opens for a (new) target.
	$effect(() => {
		if (open) {
			name = initialName;
			error = null;
		}
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>{isRename ? 'Rename collection' : 'Create collection'}</Dialog.Title>
			<Dialog.Description>
				{isRename
					? `Give "${initialName}" a new name.`
					: 'Group related feeds under a new collection.'}
			</Dialog.Description>
		</Dialog.Header>
		{#if error}
			<p class="text-sm text-destructive">{error}</p>
		{/if}
		<form
			method="POST"
			action={isRename ? '/?/renameCollection' : '/?/createCollection'}
			use:enhance={() => {
				busy = true;
				error = null;
				return async ({ result, update }) => {
					busy = false;
					if (result.type === 'failure') {
						error = String(
							(result.data as Record<string, unknown>)?.message ?? 'Something went wrong'
						);
					} else {
						error = null;
						open = false;
					}
					await update();
				};
			}}
			class="flex items-end gap-2"
		>
			{#if isRename}
				<input type="hidden" name="id" value={collectionId} />
			{/if}
			<div class="flex min-w-0 flex-1 flex-col gap-2">
				<Label for="collection-name">Name</Label>
				<Input id="collection-name" name="name" placeholder="e.g. Research" bind:value={name} />
			</div>
			<Button type="submit" size="sm" disabled={busy || !name.trim()}>
				{isRename ? 'Save' : 'Create'}
			</Button>
		</form>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)} type="button">Cancel</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
