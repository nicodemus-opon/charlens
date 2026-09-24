<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import * as InputGroup from '$lib/components/ui/input-group/index.js';
	import { cn } from '$lib/utils.js';
	import { Search } from '@lucide/svelte';

	let { placeholder = 'Search…', class: className }: { placeholder?: string; class?: string } =
		$props();

	let query = $state('');
	/** Last value we synced into the input, so typing is never clobbered by the URL. */
	let synced = $state<string | null>(null);
	let debounce: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const current = $page.url.searchParams.get('q');
		if (current === synced) return;
		synced = current;
		query = current ?? '';
	});

	function onSearchInput() {
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(() => {
			const url = new URL($page.url);
			const next = query.trim();
			if (next) url.searchParams.set('q', next);
			else url.searchParams.delete('q');
			url.searchParams.delete('article');
			synced = next || null;
			goto(`${url.pathname}?${url.searchParams.toString()}`, { keepFocus: true });
		}, 350);
	}
</script>

<InputGroup.Root class={cn('min-w-0 flex-1', className)}>
	<InputGroup.Input
		type="search"
		{placeholder}
		aria-label={placeholder}
		bind:value={query}
		oninput={onSearchInput}
	/>
	<InputGroup.Addon>
		<Search />
	</InputGroup.Addon>
</InputGroup.Root>
