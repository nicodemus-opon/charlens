<script lang="ts">
	import * as ButtonGroup from '$lib/components/ui/button-group/index.js';
	import { Toggle } from '$lib/components/ui/toggle/index.js';
	import type { ArticleView } from '$lib/article.js';
	import { LayoutGrid, List, Newspaper, Rows3 } from '@lucide/svelte';

	let { view = $bindable('list') }: { view: ArticleView } = $props();
</script>

<ButtonGroup.Root aria-label="Article layout">
	<Toggle
		variant="outline"
		size="sm"
		class="min-h-11 min-w-11 md:min-h-0 md:min-w-0"
		aria-label="List layout"
		pressed={view === 'list'}
		onPressedChange={() => (view = 'list')}
	>
		<List />
	</Toggle>
	<Toggle
		variant="outline"
		size="sm"
		class="min-h-11 min-w-11 md:min-h-0 md:min-w-0"
		aria-label="Compact layout"
		pressed={view === 'compact'}
		onPressedChange={() => (view = 'compact')}
	>
		<Rows3 />
	</Toggle>
	<Toggle
		variant="outline"
		size="sm"
		class="min-h-11 min-w-11 md:min-h-0 md:min-w-0"
		aria-label="Card layout"
		pressed={view === 'grid'}
		onPressedChange={() => (view = 'grid')}
	>
		<LayoutGrid />
	</Toggle>
	<Toggle
		variant="outline"
		size="sm"
		class="min-h-11 min-w-11 md:min-h-0 md:min-w-0"
		aria-label="Magazine layout"
		pressed={view === 'magazine'}
		onPressedChange={() => (view = 'magazine')}
	>
		<Newspaper />
	</Toggle>
</ButtonGroup.Root>
