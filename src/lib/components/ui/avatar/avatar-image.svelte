<script lang="ts">
	import { Avatar as AvatarPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		variant = 'default',
		class: className,
		...restProps
	}: AvatarPrimitive.ImageProps & {
		variant?: 'default' | 'feed';
	} = $props();
</script>

<AvatarPrimitive.Image
	bind:ref
	data-slot="avatar-image"
	data-variant={variant}
	class={cn(
		'aspect-square size-full rounded-[inherit] object-cover',
		variant === 'feed' && 'rounded-sm object-contain',
		className
	)}
	{...restProps}
/>
