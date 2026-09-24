<script lang="ts">
	import { Monitor, Moon, Sun, SunMoon } from '@lucide/svelte';
	import { setMode, userPrefersMode } from 'mode-watcher';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';

	type ModeOption = {
		value: 'light' | 'dark' | 'system';
		label: string;
		icon: typeof Sun;
	};

	const options: ModeOption[] = [
		{ value: 'system', label: 'System', icon: Monitor },
		{ value: 'light', label: 'Light', icon: Sun },
		{ value: 'dark', label: 'Dark', icon: Moon }
	];

	const preferred = $derived(userPrefersMode.current);
	const active = $derived(options.find((option) => option.value === preferred) ?? options[0]);

	function select(value: string) {
		if (value === 'light' || value === 'dark' || value === 'system') {
			setMode(value);
		}
	}
</script>

<!-- Rendered inside a `DropdownMenu.Content` — the "Appearance" config submenu. -->
<DropdownMenu.Sub>
	<DropdownMenu.SubTrigger>
		<SunMoon />
		Appearance
		<span class="ml-auto text-muted-foreground">{active.label}</span>
	</DropdownMenu.SubTrigger>
	<DropdownMenu.SubContent>
		<DropdownMenu.RadioGroup value={preferred} onValueChange={select}>
			{#each options as option (option.value)}
				{@const Icon = option.icon}
				<DropdownMenu.RadioItem value={option.value}>
					<Icon />
					{option.label}
				</DropdownMenu.RadioItem>
			{/each}
		</DropdownMenu.RadioGroup>
	</DropdownMenu.SubContent>
</DropdownMenu.Sub>
