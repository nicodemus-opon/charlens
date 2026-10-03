<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Kbd } from '$lib/components/ui/kbd/index.js';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const bindings: { keys: string[]; label: string }[] = [
		{ keys: ['j'], label: 'Next story' },
		{ keys: ['k'], label: 'Previous story' },
		{ keys: ['o'], label: 'Open selected story' },
		{ keys: ['s'], label: 'Save / unsave story' },
		{ keys: ['m'], label: 'Toggle read / unread' },
		{ keys: ['Shift', 'A'], label: 'Mark all as read' },
		{ keys: ['/'], label: 'Focus search' },
		{ keys: ['Esc'], label: 'Back to list' },
		{ keys: ['?'], label: 'This dialog' }
	];
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Keyboard shortcuts</Dialog.Title>
			<Dialog.Description>Read and triage without leaving the keyboard.</Dialog.Description>
		</Dialog.Header>
		<ul class="flex flex-col gap-2 py-2">
			{#each bindings as b (b.label)}
				<li class="flex items-center justify-between gap-4">
					<span class="text-sm text-muted-foreground">{b.label}</span>
					<span class="flex items-center gap-1">
						{#each b.keys as key (key)}
							<Kbd>{key}</Kbd>
						{/each}
					</span>
				</li>
			{/each}
		</ul>
	</Dialog.Content>
</Dialog.Root>
