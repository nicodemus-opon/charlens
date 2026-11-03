<script lang="ts">
	import { page } from '$app/stores';
	import type { ArticleRow } from '$lib/article.js';
	import ArticleImage from '$lib/components/article-image.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';

	let {
		articles = [],
		href,
		onSelect
	}: {
		articles: ArticleRow[];
		href?: (id: number) => string;
		onSelect?: (id: number) => void;
	} = $props();

	function articleHref(id: number) {
		if (href) return href(id);
		const url = new URL($page.url);
		url.searchParams.set('article', String(id));
		return `${url.pathname}?${url.searchParams.toString()}`;
	}

	function dateLabel(d: Date | string | null) {
		if (!d) return '';
		const date = d instanceof Date ? d : new Date(d);
		return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}
</script>

{#if articles.length > 0}
	<Separator class="mt-6" />
	<section aria-label="Recommended articles" class="flex flex-col gap-4 pt-6">
		<div class="flex items-center justify-between gap-2">
			<h2 class="text-lg font-semibold text-foreground">Recommended articles</h2>
			<p class="text-xs text-muted-foreground">{articles.length} related</p>
		</div>
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
			{#each articles as a (a.id)}
				<a
					href={articleHref(a.id)}
					onclick={() => onSelect?.(a.id)}
					class="block min-w-0 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				>
					<Card.Root class="h-full w-full">
						<ArticleImage seed={a} src={a.imageUrl} alt="" class="aspect-video w-full" />
						<Card.Content class="flex w-full flex-1 flex-col gap-1">
							<div class="flex items-center gap-2 text-xs text-muted-foreground">
								<span class="min-w-0 flex-1 truncate">{a.feedTitle}</span>
								<span class="shrink-0">{dateLabel(a.publishedAt)}</span>
							</div>
							<Card.Title class="line-clamp-2">{a.title}</Card.Title>
							{#if a.excerpt}
								<p class="line-clamp-2 text-xs text-muted-foreground">{a.excerpt}</p>
							{/if}
							{#if !a.isRead || a.isSaved}
								<div class="flex flex-wrap gap-1 pt-1">
									{#if !a.isRead}<Badge variant="default">New</Badge>{/if}
									{#if a.isSaved}<Badge variant="secondary">Saved</Badge>{/if}
								</div>
							{/if}
						</Card.Content>
					</Card.Root>
				</a>
			{/each}
		</div>
	</section>
{/if}
