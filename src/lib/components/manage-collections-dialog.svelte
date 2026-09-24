<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { GENERAL_COLLECTION, type CollectionRow } from '$lib/collections';

	let {
		open = $bindable(false),
		collections = [],
		feeds = []
	}: {
		open?: boolean;
		collections?: CollectionRow[];
		feeds?: { id: number; title: string; collectionId: number | null }[];
	} = $props();

	let newName = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);
	// Per-collection move-form selections (shadcn Select binds, hidden inputs submit).
	let moveSel = $state<Record<number, { feed: string; target: string }>>({});

	function selFor(id: number) {
		return moveSel[id] ?? { feed: '', target: '' };
	}

	function after(result: { type: string; data?: unknown }, reset?: () => void) {
		busy = false;
		if (result.type === 'failure') {
			error = String((result.data as Record<string, unknown>)?.message ?? 'Something went wrong');
		} else {
			error = null;
			reset?.();
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Manage collections</Dialog.Title>
			<Dialog.Description>
				Rename collections, move feeds between them, or delete the ones you no longer need. Deleting
				a collection moves its feeds back to {GENERAL_COLLECTION}.
			</Dialog.Description>
		</Dialog.Header>
		{#if error}
			<p class="text-sm text-destructive">{error}</p>
		{/if}
		<div class="flex max-h-72 flex-col gap-4 overflow-y-auto py-2">
			{#each collections as c (c.id)}
				<div class="flex flex-col gap-2 border-b border-border pb-3">
					<form
						method="POST"
						action="/?/renameCollection"
						use:enhance={() => {
							busy = true;
							error = null;
							return async ({ result, update }) => {
								after(result);
								await update();
							};
						}}
						class="flex items-end gap-2"
					>
						<input type="hidden" name="id" value={c.id} />
						<div class="flex min-w-0 flex-1 flex-col gap-2">
							<Label for="rename-{c.id}">Collection</Label>
							<Input id="rename-{c.id}" name="name" value={c.name} />
						</div>
						<Button variant="outline" size="sm" type="submit" disabled={busy}>Rename</Button>
					</form>
					{#if c.name !== GENERAL_COLLECTION}
						{@const inHere = feeds.filter((f) => f.collectionId === c.id)}
						<div class="flex items-center gap-2">
							<form
								method="POST"
								action="/?/moveFeed"
								use:enhance={() => {
									busy = true;
									error = null;
									return async ({ result, update }) => {
										after(result);
										await update();
									};
								}}
								class="flex min-w-0 flex-1 items-center gap-2"
							>
								<Select.Root
									type="single"
									name="feedId"
									bind:value={
										() => selFor(c.id).feed, (v) => (moveSel[c.id] = { ...selFor(c.id), feed: v })
									}
								>
									<Select.Trigger aria-label="Feed to move" class="min-w-0 flex-1">
										<Select.Value placeholder="Feed" />
									</Select.Trigger>
									<Select.Content>
										{#each inHere as f (f.id)}
											<Select.Item value={String(f.id)}>{f.title}</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
								<Select.Root
									type="single"
									name="collectionId"
									bind:value={
										() => selFor(c.id).target,
										(v) => (moveSel[c.id] = { ...selFor(c.id), target: v })
									}
								>
									<Select.Trigger aria-label="Target collection" class="min-w-0 flex-1">
										<Select.Value placeholder="Target" />
									</Select.Trigger>
									<Select.Content>
										{#each collections as target (target.id)}
											{#if target.id !== c.id}
												<Select.Item value={String(target.id)}>{target.name}</Select.Item>
											{/if}
										{/each}
									</Select.Content>
								</Select.Root>
								<Button
									variant="outline"
									size="sm"
									type="submit"
									disabled={busy || !selFor(c.id).feed || !selFor(c.id).target}
								>
									Move
								</Button>
							</form>
							<form
								method="POST"
								action="/?/deleteCollection"
								use:enhance={() => {
									busy = true;
									error = null;
									return async ({ result, update }) => {
										after(result);
										await update();
									};
								}}
							>
								<input type="hidden" name="id" value={c.id} />
								<Button variant="destructive" size="sm" type="submit" disabled={busy}>
									Delete
								</Button>
							</form>
						</div>
					{/if}
				</div>
			{/each}
		</div>
		<form
			method="POST"
			action="/?/createCollection"
			use:enhance={() => {
				busy = true;
				error = null;
				return async ({ result, update }) => {
					after(result, () => (newName = ''));
					await update();
				};
			}}
			class="flex items-end gap-2"
		>
			<div class="flex min-w-0 flex-1 flex-col gap-2">
				<Label for="new-collection">New collection</Label>
				<Input id="new-collection" name="name" placeholder="e.g. Research" bind:value={newName} />
			</div>
			<Button type="submit" size="sm" disabled={busy || !newName.trim()}>Create</Button>
		</form>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)} type="button">Done</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
