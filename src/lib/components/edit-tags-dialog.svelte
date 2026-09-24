<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';

	let {
		open = $bindable(false),
		initial = '',
		articleTitle = '',
		articleId = 0
	}: {
		open?: boolean;
		initial?: string;
		articleTitle?: string;
		articleId?: number;
	} = $props();

	let value = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		if (open) {
			// Re-seed the input from the article's current tags each time the dialog opens.
			value = initial;
			error = null;
		}
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Edit tags</Dialog.Title>
			<Dialog.Description>
				{#if articleTitle}
					Comma-separated tags for “{articleTitle}”.
				{:else}
					Comma-separated tags for this article.
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<form
			method="POST"
			action="/?/setArticleTags"
			use:enhance={() => {
				busy = true;
				error = null;
				return async ({ result, update }) => {
					busy = false;
					if (result.type === 'failure') {
						error = String(
							(result.data as Record<string, unknown>)?.message ?? 'Could not save tags'
						);
					} else {
						open = false;
					}
					await update();
				};
			}}
		>
			<input type="hidden" name="id" value={articleId} />
			<div class="flex flex-col gap-3 py-2">
				<div class="flex flex-col gap-2">
					<Label for="article-tags">Tags</Label>
					<Input
						id="article-tags"
						name="tags"
						placeholder="ai, research, long-read"
						autocomplete="off"
						bind:value
					/>
				</div>
				{#if error}
					<p class="text-sm text-destructive">{error}</p>
				{/if}
			</div>
			<Dialog.Footer>
				<Button variant="outline" onclick={() => (open = false)} type="button">Cancel</Button>
				<Button type="submit" disabled={busy}>Save tags</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
