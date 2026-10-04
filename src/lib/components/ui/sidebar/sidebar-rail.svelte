<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import { useSidebar } from './context.svelte.js';
	import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from './constants.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLButtonElement>, HTMLButtonElement> = $props();

	const sidebar = useSidebar();

	let dragState: {
		startX: number;
		startWidth: number;
		min: number;
		max: number;
		side: 'left' | 'right';
		moved: boolean;
	} | null = null;
	let suppressClick = false;

	function rootFontSize() {
		const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
		return Number.isFinite(size) && size > 0 ? size : 16;
	}

	function handlePointerDown(e: PointerEvent) {
		if (e.button !== 0 || sidebar.isMobile || sidebar.state === 'collapsed') return;
		const host = (e.currentTarget as HTMLElement).closest('[data-side]');
		const side = host?.getAttribute('data-side') === 'right' ? 'right' : 'left';
		const fontSize = rootFontSize();
		dragState = {
			startX: e.clientX,
			startWidth: Number.parseFloat(sidebar.width) * fontSize,
			min: Number.parseFloat(SIDEBAR_WIDTH_MIN) * fontSize,
			max: Number.parseFloat(SIDEBAR_WIDTH_MAX) * fontSize,
			side,
			moved: false
		};
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function handlePointerMove(e: PointerEvent) {
		if (!dragState) return;
		const delta = e.clientX - dragState.startX;
		if (Math.abs(delta) < 3) return;
		dragState.moved = true;
		const direction = dragState.side === 'right' ? -1 : 1;
		const next = Math.min(
			dragState.max,
			Math.max(dragState.min, dragState.startWidth + delta * direction)
		);
		sidebar.resizing = true;
		sidebar.setWidth(`${next / rootFontSize()}rem`);
	}

	function handlePointerUp(e: PointerEvent) {
		if (!dragState) return;
		if (dragState.moved) suppressClick = true;
		dragState = null;
		sidebar.resizing = false;
		try {
			(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		} catch {
			// Pointer already released — nothing to do.
		}
	}

	function handleClick(e: MouseEvent) {
		if (suppressClick) {
			e.preventDefault();
			e.stopPropagation();
			suppressClick = false;
			return;
		}
		sidebar.toggle();
	}
</script>

<button
	bind:this={ref}
	data-sidebar="rail"
	data-slot="sidebar-rail"
	aria-label="Toggle Sidebar"
	tabindex={-1}
	onclick={handleClick}
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	onpointercancel={handlePointerUp}
	title="Drag to resize or click to toggle"
	class={cn(
		'absolute inset-y-0 z-20 hidden w-4 touch-none transition-all ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:start-1/2 after:w-px hover:after:bg-sidebar-border/50 sm:flex ltr:-translate-x-1/2 rtl:-translate-x-1/2',
		'in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize',
		'[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize',
		'group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full hover:group-data-[collapsible=offcanvas]:bg-sidebar',
		'[[data-side=left][data-collapsible=offcanvas]_&]:-right-2',
		'[[data-side=right][data-collapsible=offcanvas]_&]:-left-2',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</button>
