<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import type { ArticleView } from '$lib/article.js';
	import { LayoutGrid, List, Newspaper, Rows3 } from '@lucide/svelte';

	let { view = $bindable('list') }: { view: ArticleView } = $props();

	const options: { value: ArticleView; label: string; icon: typeof List }[] = [
		{ value: 'list', label: 'List layout', icon: List },
		{ value: 'compact', label: 'Compact layout', icon: Rows3 },
		{ value: 'grid', label: 'Card layout', icon: LayoutGrid },
		{ value: 'magazine', label: 'Magazine layout', icon: Newspaper }
	];

	const active = $derived(options.find((o) => o.value === view) ?? options[0]);

	function select(value: string) {
		if (value === 'list' || value === 'compact' || value === 'grid' || value === 'magazine') {
			view = value;
		}
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger aria-label="Change article layout, current: {active.label}">
		{#snippet child({ props })}
			<Button
				{...props}
				variant="outline"
				size="icon-sm"
				class="min-h-11 min-w-11 md:min-h-0 md:min-w-0"
			>
				<active.icon />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-52">
		<DropdownMenu.Label>Layout</DropdownMenu.Label>
		<DropdownMenu.Separator />
		<DropdownMenu.RadioGroup value={view} onValueChange={select}>
			{#each options as option (option.value)}
				{@const Icon = option.icon}
				<DropdownMenu.RadioItem value={option.value} aria-label={option.label}>
					<Icon />
					{option.label}
				</DropdownMenu.RadioItem>
			{/each}
		</DropdownMenu.RadioGroup>
	</DropdownMenu.Content>
</DropdownMenu.Root>
