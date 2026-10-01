<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import type { ArticleSort } from '$lib/article.js';
	import { ArrowDownWideNarrow, ArrowDownZA, ArrowUpNarrowWide } from '@lucide/svelte';

	let { sort = $bindable('newest') }: { sort: ArticleSort } = $props();

	const options: { value: ArticleSort; label: string; icon: typeof ArrowDownWideNarrow }[] = [
		{ value: 'newest', label: 'Newest first', icon: ArrowDownWideNarrow },
		{ value: 'oldest', label: 'Oldest first', icon: ArrowUpNarrowWide },
		{ value: 'title', label: 'Title A–Z', icon: ArrowDownZA }
	];

	const active = $derived(options.find((o) => o.value === sort) ?? options[0]);

	function select(value: string) {
		if (value === 'newest' || value === 'oldest' || value === 'title') {
			sort = value;
		}
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger aria-label="Change sort order, current: {active.label}">
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
		<DropdownMenu.Label>Sort by</DropdownMenu.Label>
		<DropdownMenu.Separator />
		<DropdownMenu.RadioGroup value={sort} onValueChange={select}>
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
