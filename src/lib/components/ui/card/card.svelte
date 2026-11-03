<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		size = 'default',
		bleed = false,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		size?: 'default' | 'sm';
		/** Full-bleed leading image: drops the root gap/padding so a
		 * first-child `article-image` fills the top, bottom, and leading edge.
		 * Text spacing moves to the direct `card-content` child. */
		bleed?: boolean;
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="card"
	data-size={size}
	class={cn(
		'group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-sm text-card-foreground ring-1 ring-foreground/10 [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>[data-slot=article-image]:first-child]:pt-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[[data-slot=article-image]:first-child]:rounded-t-xl *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl',
		bleed &&
			'gap-0 py-0 [&>[data-slot=article-image]:first-child]:rounded-none [&>[data-slot=card-content]]:py-(--card-spacing)',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
