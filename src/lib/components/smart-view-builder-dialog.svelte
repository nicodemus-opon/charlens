<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Toggle } from '$lib/components/ui/toggle/index.js';

	let {
		open = $bindable(false),
		feeds = [],
		tags = []
	}: {
		open?: boolean;
		feeds?: { id: number; title: string }[];
		tags?: { id: number; name: string; count: number }[];
	} = $props();

	let name = $state('');
	let match = $state('all');
	let keywords = $state('');
	let author = $state('');
	let feedScope = $state('');
	let tagScope = $state('');
	let unreadOnly = $state(false);
	let savedOnly = $state(false);
	let daysBack = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);

	function reset() {
		name = '';
		keywords = '';
		author = '';
		feedScope = '';
		tagScope = '';
		unreadOnly = false;
		savedOnly = false;
		daysBack = '';
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>New smart view</Dialog.Title>
			<Dialog.Description>
				Build a dynamic reading view from rules. It fills automatically as new stories arrive — no
				feeds are moved.
			</Dialog.Description>
		</Dialog.Header>
		<form
			method="POST"
			action="/?/createSmartView"
			use:enhance={() => {
				busy = true;
				error = null;
				return async ({ result, update }) => {
					busy = false;
					if (result.type === 'failure') {
						error = String(
							(result.data as Record<string, unknown>)?.message ?? 'Could not create smart view'
						);
					} else {
						open = false;
						reset();
					}
					await update();
				};
			}}
		>
			<div class="flex flex-col gap-3 py-2">
				<div class="flex flex-col gap-2">
					<Label for="smart-name">Name</Label>
					<Input id="smart-name" name="name" placeholder="e.g. AI launches" bind:value={name} />
				</div>
				<div class="flex gap-2">
					<div class="flex min-w-0 flex-1 flex-col gap-2">
						<Label>Match</Label>
						<Select.Root type="single" name="match" bind:value={match}>
							<Select.Trigger class="w-full">
								<Select.Value placeholder="Match" />
							</Select.Trigger>
							<Select.Content>
								<Select.Item value="all">All rules</Select.Item>
								<Select.Item value="any">Any rule</Select.Item>
							</Select.Content>
						</Select.Root>
					</div>
					<div class="flex min-w-0 flex-1 flex-col gap-2">
						<Label>Feeds</Label>
						<Select.Root type="single" name="feedIds" bind:value={feedScope}>
							<Select.Trigger class="w-full">
								<Select.Value placeholder="All feeds" />
							</Select.Trigger>
							<Select.Content>
								<Select.Item value="">All feeds</Select.Item>
								{#each feeds as f (f.id)}
									<Select.Item value={String(f.id)}>{f.title}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				</div>
				<div class="flex flex-col gap-2">
					<Label for="smart-keywords">Keywords (comma-separated)</Label>
					<Input
						id="smart-keywords"
						name="keywords"
						placeholder="launch, funding, paper"
						bind:value={keywords}
					/>
				</div>
				<div class="flex flex-col gap-2">
					<Label for="smart-tags">Tags (comma-separated)</Label>
					<Input
						id="smart-tags"
						name="tags"
						list="smart-tags-list"
						placeholder={tags.length > 0
							? tags
									.slice(0, 3)
									.map((t) => t.name)
									.join(', ')
							: 'ai, research'}
						bind:value={tagScope}
					/>
					{#if tags.length > 0}
						<datalist id="smart-tags-list">
							{#each tags as t (t.id)}
								<option value={t.name}></option>
							{/each}
						</datalist>
					{/if}
				</div>
				<div class="flex gap-2">
					<div class="flex min-w-0 flex-1 flex-col gap-2">
						<Label for="smart-author">Author contains</Label>
						<Input id="smart-author" name="author" placeholder="Optional" bind:value={author} />
					</div>
					<div class="flex w-28 flex-col gap-2">
						<Label for="smart-days">Days back</Label>
						<Input
							id="smart-days"
							name="daysBack"
							type="number"
							min="1"
							placeholder="Any"
							bind:value={daysBack}
						/>
					</div>
				</div>
				<div class="flex gap-2">
					<input type="hidden" name="unreadOnly" value={unreadOnly ? 'on' : ''} />
					<input type="hidden" name="savedOnly" value={savedOnly ? 'on' : ''} />
					<Toggle variant="outline" bind:pressed={unreadOnly} aria-label="Unread only">
						Unread only
					</Toggle>
					<Toggle variant="outline" bind:pressed={savedOnly} aria-label="Saved only">
						Saved only
					</Toggle>
				</div>
				{#if error}
					<p class="text-sm text-destructive">{error}</p>
				{/if}
			</div>
			<Dialog.Footer>
				<Button variant="outline" onclick={() => (open = false)} type="button">Cancel</Button>
				<Button type="submit" disabled={busy || !name.trim()}>Create smart view</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
