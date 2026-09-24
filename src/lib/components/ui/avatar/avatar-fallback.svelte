<script lang="ts">
	import { Avatar as AvatarPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		variant = 'default',
		class: className,
		...restProps
	}: AvatarPrimitive.FallbackProps & {
		variant?: 'default' | 'feed';
	} = $props();
</script>

<AvatarPrimitive.Fallback
	bind:ref
	data-slot="avatar-fallback"
	data-variant={variant}
	class={cn(
		'flex size-full items-center justify-center rounded-[inherit] bg-muted text-sm text-muted-foreground group-data-[size=sm]/avatar:text-xs',
		variant === 'feed' && 'rounded-sm text-xs',
		className
	)}
	{...restProps}
/>
