<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { cn } from '$lib/utils.js';
	import {
		Bookmark,
		BookmarkCheck,
		CheckCheck,
		EyeOff,
		MegaphoneOff,
		MoreHorizontal,
		Newspaper
	} from '@lucide/svelte';

	let {
		articleId,
		isSaved = false,
		isRead = false,
		/** Hide until the parent card/row is hovered (desktop); always visible on touch. */
		hoverOnly = true,
		/** Float as an overlay chip on image cards instead of sitting inline. */
		overlay = false
	}: {
		articleId: number;
		isSaved?: boolean;
		isRead?: boolean;
		hoverOnly?: boolean;
		overlay?: boolean;
	} = $props();

	let feedbackKind = $state('dismiss');
	let feedbackForm = $state<HTMLFormElement | null>(null);
	let saveForm = $state<HTMLFormElement | null>(null);
	let readForm = $state<HTMLFormElement | null>(null);

	function submitFeedback(next: string) {
		feedbackKind = next;
		// Let the menu close first so the hidden form submit isn't swallowed.
		requestAnimationFrame(() => feedbackForm?.requestSubmit());
	}

	function submitPlain(form: HTMLFormElement | null) {
		requestAnimationFrame(() => form?.requestSubmit());
	}

	function revalidate() {
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			await invalidateAll();
		};
	}
</script>

<span
	class={cn(
		'inline-flex shrink-0',
		overlay && 'absolute top-2 right-2 rounded-md border border-border bg-card',
		hoverOnly && 'md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100'
	)}
>
	<DropdownMenu.Root>
		<DropdownMenu.Trigger aria-label="Article actions">
			{#snippet child({ props })}
				<Button {...props} variant="ghost" size="icon-sm" type="button" title="Article actions">
					<MoreHorizontal />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="w-56">
			<DropdownMenu.Item onSelect={() => submitPlain(saveForm)}>
				{#if isSaved}<BookmarkCheck />{:else}<Bookmark />{/if}
				{isSaved ? 'Remove from Read later' : 'Save for later'}
			</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={() => submitPlain(readForm)}>
				<CheckCheck />
				{isRead ? 'Mark as unread' : 'Mark as read'}
			</DropdownMenu.Item>
			<DropdownMenu.Separator />
			<DropdownMenu.Label>Less like this</DropdownMenu.Label>
			<DropdownMenu.Item onSelect={() => submitFeedback('dismiss')}>
				<EyeOff />
				Not interested
			</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={() => submitFeedback('mute_feed')}>
				<Newspaper />
				Don't show this feed
			</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={() => submitFeedback('mute_topic')}>
				<MegaphoneOff />
				Don't show this topic
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
</span>
<form
	method="POST"
	action="/?/feedback"
	use:enhance={revalidate}
	class="hidden"
	bind:this={feedbackForm}
>
	<input type="hidden" name="id" value={articleId} />
	<input type="hidden" name="kind" value={feedbackKind} />
</form>
<form
	method="POST"
	action="/?/toggleSaved"
	use:enhance={revalidate}
	class="hidden"
	bind:this={saveForm}
>
	<input type="hidden" name="id" value={articleId} />
</form>
<form
	method="POST"
	action="/?/toggleRead"
	use:enhance={revalidate}
	class="hidden"
	bind:this={readForm}
>
	<input type="hidden" name="id" value={articleId} />
</form>
