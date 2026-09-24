<script lang="ts">
	import * as ButtonGroup from '$lib/components/ui/button-group/index.js';
	import { Toggle } from '$lib/components/ui/toggle/index.js';
	import type { ArticleView } from '$lib/article.js';
	import { LayoutGrid, List, Rows3 } from '@lucide/svelte';

	let { view = $bindable('list') }: { view: ArticleView } = $props();
</script>

<ButtonGroup.Root aria-label="Article layout">
	<Toggle
		variant="outline"
		size="sm"
		aria-label="List layout"
		pressed={view === 'list'}
		onPressedChange={() => (view = 'list')}
	>
		<List />
	</Toggle>
	<Toggle
		variant="outline"
		size="sm"
		aria-label="Compact layout"
		pressed={view === 'compact'}
		onPressedChange={() => (view = 'compact')}
	>
		<Rows3 />
	</Toggle>
	<Toggle
		variant="outline"
		size="sm"
		aria-label="Card layout"
		pressed={view === 'grid'}
		onPressedChange={() => (view = 'grid')}
	>
		<LayoutGrid />
	</Toggle>
</ButtonGroup.Root>
