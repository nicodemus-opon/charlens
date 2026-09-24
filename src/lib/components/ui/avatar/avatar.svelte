<script lang="ts">
	import { Avatar as AvatarPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		loadingStatus = $bindable('loading'),
		size = 'default',
		variant = 'default',
		shape = 'circle',
		class: className,
		...restProps
	}: AvatarPrimitive.RootProps & {
		size?: 'default' | 'sm' | 'lg';
		variant?: 'default' | 'feed';
		shape?: 'circle' | 'square';
	} = $props();
</script>

<AvatarPrimitive.Root
	bind:ref
	bind:loadingStatus
	data-slot="avatar"
	data-size={size}
	data-variant={variant}
	class={cn(
		'group/avatar relative flex size-8 shrink-0 overflow-hidden rounded-full select-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-border after:mix-blend-darken data-[size=lg]:size-10 data-[size=sm]:size-6 dark:after:mix-blend-lighten',
		variant === 'feed' && 'rounded-md p-0.5 after:rounded-md after:border-0',
		shape === 'square' && 'rounded-lg',
		className
	)}
	{...restProps}
/>
