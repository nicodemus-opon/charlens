<script lang="ts">
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import type { Snippet } from 'svelte';

	let {
		title,
		description,
		checked = $bindable(false),
		disabled = false,
		onChange,
		children
	}: {
		title: string;
		description?: string;
		checked?: boolean;
		disabled?: boolean;
		onChange?: (value: boolean) => void;
		children?: Snippet;
	} = $props();

	const controlId = $derived(`setting-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
</script>

<div class="flex items-center justify-between gap-4 py-4">
	<div class="min-w-0 flex-1">
		<Label for={controlId} class="text-sm">{title}</Label>
		{#if description}
			<p class="mt-1 text-xs text-muted-foreground">{description}</p>
		{/if}
		{#if children}
			{@render children()}
		{/if}
	</div>
	<Switch
		id={controlId}
		bind:checked
		{disabled}
		aria-label={title}
		class="shrink-0"
		onCheckedChange={(v) => onChange?.(v)}
	/>
</div>
