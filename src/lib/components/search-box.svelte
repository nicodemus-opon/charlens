<script lang="ts">
	import { onDestroy } from 'svelte';
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
	let inputEl: HTMLInputElement | null = $state(null);

	function isFocused() {
		return inputEl != null && document.activeElement === inputEl;
	}

	$effect(() => {
		const current = $page.url.searchParams.get('q');
		if (current === synced) return;
		synced = current;
		// A slow `goto` landing after further typing must not overwrite the
		// in-flight text — only sync the URL value when the field isn't focused.
		if (isFocused()) return;
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
			const qs = url.searchParams.toString();
			goto(qs ? `${url.pathname}?${qs}` : url.pathname, {
				replaceState: true,
				keepFocus: true,
				noScroll: true
			});
		}, 350);
	}

	function onSearchBlur() {
		// An external navigation (e.g. scope change clearing `?q=`) that landed
		// while focused skipped the input update — apply it on blur.
		const current = $page.url.searchParams.get('q') ?? '';
		if (query !== current) {
			synced = $page.url.searchParams.get('q');
			query = current;
		}
	}

	onDestroy(() => {
		if (debounce) clearTimeout(debounce);
	});
</script>

<InputGroup.Root class={cn('min-w-0 flex-1', className)}>
	<InputGroup.Input
		type="search"
		{placeholder}
		aria-label={placeholder}
		data-search-input
		bind:ref={inputEl}
		bind:value={query}
		oninput={onSearchInput}
		onblur={onSearchBlur}
	/>
	<InputGroup.Addon>
		<Search />
	</InputGroup.Addon>
</InputGroup.Root>
