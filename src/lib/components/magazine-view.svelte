<script lang="ts">
	import { page } from '$app/stores';
	import type { ArticleRow } from '$lib/article.js';
	import ArticleImage from '$lib/components/article-image.svelte';
	import { buildMagazineSections, getStoryEmphasis } from '$lib/magazine.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import ArticleFeedbackMenu from '$lib/components/article-feedback-menu.svelte';
	import { cn } from '$lib/utils.js';
	import { Clock, Newspaper } from '@lucide/svelte';

	let {
		articles = [],
		href,
		tagHref,
		emptyTitle = 'No articles yet',
		emptyDescription = 'Add a feed or hit refresh to pull the latest stories.',
		showFeedback = false,
		/** False when an ancestor owns the scroll container (sticky translucent header scrolls over this list). */
		scrollable = true,
		onSelect
	}: {
		articles: ArticleRow[];
		href?: (id: number) => string;
		/**
		 * Builds the href for a topic. Defaults to scoping the list to that tag
		 * on the current URL; override when there is no SvelteKit `$page`
		 * context (e.g. component tests).
		 */
		tagHref?: (tagId: number) => string;
		emptyTitle?: string;
		emptyDescription?: string;
		/** True on Recommended: cards get a "less like this" overlay menu. */
		showFeedback?: boolean;
		scrollable?: boolean;
		onSelect?: (id: number) => void;
	} = $props();

	const selectedId = $derived(href ? null : $page.url.searchParams.get('article'));
	const sections = $derived(buildMagazineSections(articles));

	function articleHref(id: number) {
		if (href) return href(id);
		const url = new URL($page.url);
		url.searchParams.set('article', String(id));
		return `${url.pathname}?${url.searchParams.toString()}`;
	}

	/**
	 * Topic chips and desk headers open the list scoped to that tag: the
	 * previous scope (feed/collection/smart view/search) is dropped and the
	 * article is cleared so the tag view reads unambiguously.
	 */
	function tagFilterHref(tagId: number) {
		if (tagHref) return tagHref(tagId);
		const url = new URL($page.url);
		url.searchParams.set('filter', 'all');
		url.searchParams.set('tag', String(tagId));
		url.searchParams.delete('feed');
		url.searchParams.delete('collection');
		url.searchParams.delete('view');
		url.searchParams.delete('q');
		url.searchParams.delete('article');
		return `${url.pathname}?${url.searchParams.toString()}`;
	}

	/** One clean 12-col row: items stretch to equal height, edges align. */
	function rowGridClass() {
		return 'grid grid-cols-12 items-stretch gap-3';
	}

	/** Static span classes only - lint-safe, every row sums to 12. */
	function spanClass(span: number) {
		if (span === 12) return 'col-span-12';
		if (span === 8) return 'col-span-12 lg:col-span-8';
		if (span === 6) return 'col-span-12 sm:col-span-6';
		if (span === 4) return 'col-span-12 sm:col-span-6 lg:col-span-4';
		return 'col-span-12 sm:col-span-6 lg:col-span-3';
	}

	/** Card treatment for a placed story: feature renders horizontally. */
	function cardVariant(span: number, textOnly: boolean): 'feature' | 'standard' | 'text' {
		if (textOnly) return 'text';
		if (span === 8 || span === 12) return 'feature';
		return 'standard';
	}

	/** Smart title size: image-led stories earn the bigger headline. */
	function titleClass(a: ArticleRow, base: 'lead' | 'feature' | 'card') {
		const emphasis = getStoryEmphasis(a);
		if (base === 'lead')
			return 'line-clamp-2 text-xl font-bold tracking-tight text-balance text-foreground';
		if (base === 'feature')
			return 'line-clamp-2 text-lg font-bold tracking-tight text-balance text-foreground';
		if (emphasis === 'visual' || emphasis === 'featured')
			return 'line-clamp-2 text-base font-bold tracking-tight text-balance text-foreground';
		if (emphasis === 'brief')
			return 'line-clamp-1 text-sm font-medium tracking-tight text-foreground';
		return 'line-clamp-2 text-sm font-bold tracking-tight text-balance text-foreground';
	}

	/** Brief stories skip their excerpt to stay scannable. */
	function showExcerpt(a: ArticleRow) {
		return Boolean(a.excerpt) && getStoryEmphasis(a) !== 'brief';
	}

	function dateLabel(d: Date | string | null) {
		if (!d) return '';
		const date = d instanceof Date ? d : new Date(d);
		const now = new Date();
		const days = Math.floor((now.getTime() - date.getTime()) / 86400000);
		if (days <= 0) return 'Today';
		if (days === 1) return 'Yesterday';
		return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function byline(a: ArticleRow) {
		const parts = [a.feedTitle];
		if (a.author) parts.push(a.author);
		const date = dateLabel(a.publishedAt);
		if (date) parts.push(date);
		return parts.join(', ');
	}
</script>

{#snippet kicker(a: ArticleRow)}
	<div class="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
		<span class="truncate font-medium">{a.feedTitle}</span>
		{#if !a.isRead}<Badge variant="default" class="max-sm:hidden">New</Badge>{/if}
		{#if a.isSaved}<Badge variant="secondary" class="max-sm:hidden">Saved</Badge>{/if}
		{#if a.tags[0]}
			<Badge
				variant="outline"
				href={tagFilterHref(a.tags[0].id)}
				class="max-w-36 justify-start max-sm:hidden"
			>
				<span class="min-w-0 truncate">{a.tags[0].name}</span>
			</Badge>
		{/if}
	</div>
{/snippet}

{#snippet thumb(a: ArticleRow, sizes: string)}
	<ArticleImage seed={a} src={a.imageUrl} alt="" class={cn('w-full', sizes)} />
{/snippet}

{#snippet cardMenu(a: ArticleRow)}
	{#if showFeedback}
		<ArticleFeedbackMenu articleId={a.id} isSaved={a.isSaved} isRead={a.isRead} overlay />
	{/if}
{/snippet}

{#snippet storyCard(a: ArticleRow, variant: 'feature' | 'standard' | 'text' = 'standard')}
	{@const isSelected = selectedId === String(a.id)}
	<div class="group relative w-full min-w-0 flex-1">
		<a
			href={articleHref(a.id)}
			onclick={() => onSelect?.(a.id)}
			aria-current={isSelected ? 'true' : undefined}
			class={cn(
				'block h-full min-w-0 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
				isSelected && 'ring-2 ring-ring'
			)}
		>
			<Card.Root
				class={cn(
					'flex h-full min-w-0 flex-col overflow-hidden',
					variant === 'feature' && 'sm:flex-row'
				)}
			>
				{#if variant === 'text'}
					<Card.Content class="flex min-w-0 flex-1 flex-col">
						<div class="flex min-w-0 flex-1 flex-col gap-1">
							{@render kicker(a)}
							<h3 class={titleClass(a, 'card')}>{a.title}</h3>
							{#if a.excerpt}
								<p class="line-clamp-2 text-xs text-muted-foreground">{a.excerpt}</p>
							{/if}
							<p class="mt-auto truncate pt-1 text-xs text-muted-foreground">{byline(a)}</p>
						</div>
					</Card.Content>
				{:else if variant === 'feature'}
					<!-- Wide bento slot: horizontal card so the thumb stays level. -->
					<div class="w-full shrink-0 sm:w-1/2">
						{@render thumb(a, 'aspect-video sm:h-full')}
					</div>
					<Card.Content class="flex min-w-0 flex-1 flex-col">
						<div class="flex min-w-0 flex-1 flex-col gap-1">
							{@render kicker(a)}
							<h3 class={titleClass(a, 'feature')}>{a.title}</h3>
							{#if a.excerpt}
								<p class="line-clamp-2 text-xs text-muted-foreground">{a.excerpt}</p>
							{/if}
							<p class="mt-auto truncate pt-1 text-xs text-muted-foreground">{byline(a)}</p>
						</div>
					</Card.Content>
				{:else}
					{@render thumb(a, 'aspect-video')}
					<Card.Content class="flex min-w-0 flex-1 flex-col">
						<div class="flex min-w-0 flex-1 flex-col gap-1">
							{@render kicker(a)}
							<h3 class={titleClass(a, 'card')}>{a.title}</h3>
							{#if showExcerpt(a) && a.excerpt}
								<p class="line-clamp-2 text-xs text-muted-foreground">{a.excerpt}</p>
							{/if}
							<p class="mt-auto truncate pt-1 text-xs text-muted-foreground">{byline(a)}</p>
						</div>
					</Card.Content>
				{/if}
			</Card.Root>
		</a>
		{@render cardMenu(a)}
	</div>
{/snippet}

{#if articles.length === 0 || !sections.lead}
	<div class="flex flex-1 items-center justify-center p-6">
		<Empty.Root>
			<Empty.Header>
				<Empty.Media variant="icon"><Newspaper /></Empty.Media>
				<Empty.Title>{emptyTitle}</Empty.Title>
				<Empty.Description>{emptyDescription}</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	</div>
{:else}
	{@const lead = sections.lead}
	{@const hero = sections.hero}
	<div class={scrollable ? 'min-h-0 flex-1 overflow-y-auto' : 'flex-none pb-20 md:pb-0'}>
		<div class="mx-auto w-full max-w-7xl px-4 pt-6 pb-8 sm:px-5">
			{#if hero === 'trio'}
				<!-- Three image-led stories: even three-up hero row. -->
				<div class="grid items-stretch gap-3 lg:grid-cols-3">
					<div class="group relative min-w-0">
						<a
							href={articleHref(lead.id)}
							onclick={() => onSelect?.(lead.id)}
							aria-current={selectedId === String(lead.id) ? 'true' : undefined}
							class={cn(
								'block h-full min-w-0 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
								selectedId === String(lead.id) && 'ring-2 ring-ring'
							)}
						>
							<Card.Root class="flex h-full min-w-0 flex-col overflow-hidden">
								{@render thumb(lead, 'aspect-video')}
								<Card.Content class="flex min-w-0 flex-1 flex-col">
									<div class="flex min-w-0 flex-1 flex-col gap-2">
										{@render kicker(lead)}
										<h2
											class="line-clamp-2 text-xl font-bold tracking-tight text-balance text-foreground"
										>
											{lead.title}
										</h2>
										{#if lead.excerpt}
											<p class="line-clamp-1 text-xs text-muted-foreground">{lead.excerpt}</p>
										{/if}
										<p class="mt-auto flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
											<span class="truncate">{byline(lead)}</span>
											{#if lead.readMinutes}
												<span class="flex shrink-0 items-center gap-1 max-sm:hidden">
													<Clock class="size-3" />
													{lead.readMinutes} min
												</span>
											{/if}
										</p>
									</div>
								</Card.Content>
							</Card.Root>
						</a>
						{@render cardMenu(lead)}
					</div>
					{#each sections.secondary as a (a.id)}
						{@const isSelected = selectedId === String(a.id)}
						<div class="group relative min-w-0">
							<a
								href={articleHref(a.id)}
								onclick={() => onSelect?.(a.id)}
								aria-current={isSelected ? 'true' : undefined}
								class={cn(
									'block h-full min-w-0 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
									isSelected && 'ring-2 ring-ring'
								)}
							>
								<Card.Root class="flex h-full min-w-0 flex-col overflow-hidden">
									{@render thumb(a, 'aspect-video')}
									<Card.Content class="flex min-w-0 flex-1 flex-col">
										<div class="flex min-w-0 flex-1 flex-col gap-1">
											{@render kicker(a)}
											<h3 class={titleClass(a, 'card')}>
												{a.title}
											</h3>
											<p class="mt-auto truncate pt-1 text-xs text-muted-foreground">{byline(a)}</p>
										</div>
									</Card.Content>
								</Card.Root>
							</a>
							{@render cardMenu(a)}
						</div>
					{/each}
				</div>
			{:else if hero === 'split'}
				<!-- Lead + one visual backup: asymmetric 8/4 hero. -->
				<div class="grid items-stretch gap-3 lg:grid-cols-12">
					<div class="group relative min-w-0 lg:col-span-8">
						<a
							href={articleHref(lead.id)}
							onclick={() => onSelect?.(lead.id)}
							aria-current={selectedId === String(lead.id) ? 'true' : undefined}
							class={cn(
								'block h-full min-w-0 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
								selectedId === String(lead.id) && 'ring-2 ring-ring'
							)}
						>
							<Card.Root class="flex h-full min-w-0 flex-col overflow-hidden">
								{@render thumb(lead, 'aspect-video')}
								<Card.Content class="flex min-w-0 flex-1 flex-col">
									<div class="flex min-w-0 flex-1 flex-col gap-2">
										{@render kicker(lead)}
										<h2
											class="line-clamp-2 text-xl font-bold tracking-tight text-balance text-foreground"
										>
											{lead.title}
										</h2>
										{#if lead.excerpt}
											<p class="line-clamp-1 text-xs text-muted-foreground">{lead.excerpt}</p>
										{/if}
										<p class="mt-auto flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
											<span class="truncate">{byline(lead)}</span>
											{#if lead.readMinutes}
												<span class="flex shrink-0 items-center gap-1 max-sm:hidden">
													<Clock class="size-3" />
													{lead.readMinutes} min
												</span>
											{/if}
										</p>
									</div>
								</Card.Content>
							</Card.Root>
						</a>
						{@render cardMenu(lead)}
					</div>
					{#if sections.secondary.length > 0}
						<div class="flex min-w-0 flex-col gap-3 lg:col-span-4">
							{#each sections.secondary as a (a.id)}
								{@const isSelected = selectedId === String(a.id)}
								<div class="group relative min-w-0 flex-1">
									<a
										href={articleHref(a.id)}
										onclick={() => onSelect?.(a.id)}
										aria-current={isSelected ? 'true' : undefined}
										class={cn(
											'block h-full min-w-0 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
											isSelected && 'ring-2 ring-ring'
										)}
									>
										<Card.Root class="flex h-full min-w-0 flex-col overflow-hidden">
											{@render thumb(a, 'aspect-video')}
											<Card.Content class="flex min-w-0 flex-1 flex-col">
												<div class="flex min-w-0 flex-1 flex-col gap-1">
													{@render kicker(a)}
													<h3 class={titleClass(a, 'card')}>
														{a.title}
													</h3>
													<p class="mt-auto truncate pt-1 text-xs text-muted-foreground">
														{byline(a)}
													</p>
												</div>
											</Card.Content>
										</Card.Root>
									</a>
									{@render cardMenu(a)}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{:else}
				<!-- Cover: full-width horizontal feature, backups as an even pair. -->
				<div class="group relative min-w-0">
					<a
						href={articleHref(lead.id)}
						onclick={() => onSelect?.(lead.id)}
						aria-current={selectedId === String(lead.id) ? 'true' : undefined}
						class={cn(
							'block h-full min-w-0 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
							selectedId === String(lead.id) && 'ring-2 ring-ring'
						)}
					>
						<Card.Root class="h-full min-w-0 overflow-hidden sm:flex-row">
							<div class="w-full shrink-0 sm:w-1/2">
								{@render thumb(lead, 'aspect-video sm:h-full')}
							</div>
							<Card.Content class="flex min-w-0 flex-1 flex-col justify-center">
								<div class="flex min-w-0 flex-col gap-2">
									{@render kicker(lead)}
									<h2
										class="line-clamp-2 text-xl font-bold tracking-tight text-balance text-foreground"
									>
										{lead.title}
									</h2>
									{#if lead.excerpt}
										<p class="line-clamp-2 text-xs text-muted-foreground">{lead.excerpt}</p>
									{/if}
									<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
										<span class="truncate">{byline(lead)}</span>
										{#if lead.readMinutes}
											<span class="flex shrink-0 items-center gap-1 max-sm:hidden">
												<Clock class="size-3" />
												{lead.readMinutes} min
											</span>
										{/if}
									</p>
								</div>
							</Card.Content>
						</Card.Root>
					</a>
					{@render cardMenu(lead)}
				</div>
				{#if sections.secondary.length > 0}
					<div class="mt-3 grid items-stretch gap-3 sm:grid-cols-2">
						{#each sections.secondary as a (a.id)}
							{@const isSelected = selectedId === String(a.id)}
							<div class="group relative min-w-0">
								<a
									href={articleHref(a.id)}
									onclick={() => onSelect?.(a.id)}
									aria-current={isSelected ? 'true' : undefined}
									class={cn(
										'block h-full min-w-0 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
										isSelected && 'ring-2 ring-ring'
									)}
								>
									<Card.Root class="flex h-full min-w-0 flex-col overflow-hidden">
										{@render thumb(a, 'aspect-video')}
										<Card.Content class="flex min-w-0 flex-1 flex-col">
											<div class="flex min-w-0 flex-1 flex-col gap-1">
												{@render kicker(a)}
												<h3 class={titleClass(a, 'card')}>
													{a.title}
												</h3>
												<p class="mt-auto truncate pt-1 text-xs text-muted-foreground">
													{byline(a)}
												</p>
											</div>
										</Card.Content>
									</Card.Root>
								</a>
								{@render cardMenu(a)}
							</div>
						{/each}
					</div>
				{/if}
			{/if}
			{#each sections.blocks as block, bi (bi)}
				{#if block.kind === 'latest'}
					<div class="flex items-center gap-3 py-3">
						<h2 class="shrink-0 text-base font-bold tracking-tight text-foreground">Latest</h2>
						<Separator class="flex-1" />
					</div>
					<div class="flex flex-col gap-3">
						{#each block.rows as row, ri (ri)}
							<div class={rowGridClass()}>
								{#each row.stories as st (st.article.id)}
									<div class={cn(spanClass(st.span), 'flex min-w-0')}>
										{@render storyCard(st.article, cardVariant(st.span, false))}
									</div>
								{/each}
							</div>
						{/each}
					</div>
				{:else}
					{@const desk = block.desk}
					{@const textOnly = desk.pattern === 'headlines'}
					<div class="flex items-center gap-3 py-3">
						<h2 class="shrink-0 text-base font-bold tracking-tight text-foreground capitalize">
							{desk.tag.name}
						</h2>
						<Separator class="flex-1" />
						<a
							href={tagFilterHref(desk.tag.id)}
							class="shrink-0 text-xs font-medium text-primary hover:underline focus-visible:outline-none"
						>
							View all
						</a>
					</div>
					<div class="flex flex-col gap-3">
						{#each desk.rows as row, ri (ri)}
							<div class={rowGridClass()}>
								{#each row.stories as st (st.article.id)}
									<div class={cn(spanClass(st.span), 'flex min-w-0')}>
										{@render storyCard(st.article, cardVariant(st.span, textOnly))}
									</div>
								{/each}
							</div>
						{/each}
					</div>
					{#if desk.more.length > 0}
						<div
							class={desk.more.length >= 4 ? 'mt-3 grid gap-3 lg:grid-cols-2' : 'mt-3 grid gap-3'}
						>
							{#each desk.more as a, mi (a.id)}
								{@const isSelected = selectedId === String(a.id)}
								<div
									class={cn(
										'group flex min-w-0 items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 transition-colors hover:bg-accent active:bg-accent',
										isSelected && 'bg-accent'
									)}
								>
									<a
										href={articleHref(a.id)}
										onclick={() => onSelect?.(a.id)}
										aria-current={isSelected ? 'true' : undefined}
										class="flex min-w-0 flex-1 items-center gap-3 focus-visible:outline-none"
									>
										{#if mi === 0 && a.imageUrl}
											<ArticleImage
												seed={a}
												src={a.imageUrl}
												alt=""
												class="hidden h-16 w-16 shrink-0 rounded-lg sm:block"
											/>
										{/if}
										<span class="flex min-w-0 flex-1 flex-col gap-0.5">
											<span class="truncate text-sm font-medium text-foreground">{a.title}</span>
											<span class="truncate text-xs text-muted-foreground">{byline(a)}</span>
										</span>
										<span class="shrink-0 text-xs text-muted-foreground">
											{a.readMinutes ? `${a.readMinutes} min` : dateLabel(a.publishedAt)}
										</span>
									</a>
									{#if showFeedback}
										<ArticleFeedbackMenu articleId={a.id} isSaved={a.isSaved} isRead={a.isRead} />
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				{/if}
			{/each}
			{#if sections.rest.length > 0}
				<div class="flex items-center gap-3 py-3">
					<h2 class="shrink-0 text-base font-bold tracking-tight text-foreground">
						More headlines
					</h2>
					<Separator class="flex-1" />
				</div>
				<div class="overflow-hidden rounded-xl border border-border bg-card">
					{#each sections.rest as a (a.id)}
						{@const isSelected = selectedId === String(a.id)}
						<div
							class={cn(
								'group flex min-w-0 items-center gap-2 border-b border-border px-4 py-2 transition-colors last:border-b-0 hover:bg-accent active:bg-accent',
								isSelected && 'bg-accent'
							)}
						>
							<a
								href={articleHref(a.id)}
								onclick={() => onSelect?.(a.id)}
								aria-current={isSelected ? 'true' : undefined}
								class="flex min-w-0 flex-1 items-center gap-3 focus-visible:outline-none"
							>
								<span class="flex min-w-0 flex-1 flex-col gap-0.5">
									<span class="truncate text-sm font-medium text-foreground">{a.title}</span>
									<span class="truncate text-xs text-muted-foreground">{byline(a)}</span>
								</span>
								<span class="shrink-0 text-xs text-muted-foreground">
									{a.readMinutes ? `${a.readMinutes} min` : dateLabel(a.publishedAt)}
								</span>
							</a>
							{#if showFeedback}
								<ArticleFeedbackMenu articleId={a.id} isSaved={a.isSaved} isRead={a.isRead} />
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}
