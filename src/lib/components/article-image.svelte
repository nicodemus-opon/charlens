<script lang="ts">
	import { getCoverDataUri, isUsableCoverWidth, type ArtSeed } from '$lib/article-cover.js';
	import { cn } from '$lib/utils.js';

	let {
		seed,
		src = null,
		alt = '',
		class: className,
		imgClass = 'absolute inset-0 h-full w-full object-cover'
	}: {
		seed: ArtSeed;
		src?: string | null;
		alt?: string;
		class?: string;
		imgClass?: string;
	} = $props();

	// Deterministic DiceBear covers, one per color scheme: identical on server
	// and client, so the backdrop never flickers or hydrates differently.
	// Memoized per seed. The `dark:` variant follows the app's `.dark` class.
	const coverLight = $derived(getCoverDataUri(seed, 'light'));
	const coverDark = $derived(getCoverDataUri(seed, 'dark'));

	let failed = $state(false);
	let loaded = $state(false);
	let realImg: HTMLImageElement | null = $state(null);

	function judge(el: HTMLImageElement) {
		if (isUsableCoverWidth(el.naturalWidth)) loaded = true;
		else failed = true;
	}

	// Cached images may already be complete before listeners attach.
	$effect(() => {
		const el = realImg;
		if (!el || !src || failed || loaded) return;
		if (el.complete && el.naturalWidth > 0) judge(el);
		else if (el.complete) failed = true;
	});
</script>

<div data-slot="article-image" class={cn('relative overflow-hidden bg-muted', className)}>
	<img
		src={coverLight}
		alt=""
		aria-hidden="true"
		loading="lazy"
		class="absolute inset-0 h-full w-full object-cover dark:hidden"
	/>
	<img
		src={coverDark}
		alt=""
		aria-hidden="true"
		loading="lazy"
		class="absolute inset-0 hidden h-full w-full object-cover dark:block"
	/>
	{#if src && !failed}
		<img
			{src}
			{alt}
			loading="lazy"
			bind:this={realImg}
			onload={(e) => judge(e.currentTarget as HTMLImageElement)}
			onerror={() => (failed = true)}
			class={cn(imgClass, 'transition-opacity duration-200', loaded ? 'opacity-100' : 'opacity-0')}
		/>
	{/if}
</div>
