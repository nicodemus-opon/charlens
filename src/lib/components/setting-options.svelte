<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';

	let {
		title,
		description,
		value = $bindable(''),
		options,
		onChange
	}: {
		title: string;
		description?: string;
		value?: string;
		options: { value: string; label: string }[];
		onChange?: (value: string) => void;
	} = $props();

	function select(next: string) {
		if (next === value) return;
		value = next;
		onChange?.(next);
	}
</script>

<div class="flex flex-col gap-2 py-4">
	<Label class="text-sm">{title}</Label>
	{#if description}
		<p class="text-xs text-muted-foreground">{description}</p>
	{/if}
	<div class="flex flex-wrap gap-2" role="group" aria-label={title}>
		{#each options as opt (opt.value)}
			<Button
				variant={value === opt.value ? 'secondary' : 'outline'}
				size="sm"
				aria-pressed={value === opt.value}
				onclick={() => select(opt.value)}
			>
				{opt.label}
			</Button>
		{/each}
	</div>
</div>
