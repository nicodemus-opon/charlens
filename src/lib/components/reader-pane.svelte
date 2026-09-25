<script lang="ts">
	import { browser } from '$app/environment';
	import { enhance } from '$app/forms';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import {
		BookOpen,
		Bookmark,
		BookmarkCheck,
		CheckCheck,
		ChevronLeft,
		Ellipsis,
		ExternalLink,
		Eye,
		EyeOff,
		Tag
	} from '@lucide/svelte';
	import { Toggle } from '$lib/components/ui/toggle/index.js';
	import type { TagRef } from '$lib/tags';
	import EditTagsDialog from './edit-tags-dialog.svelte';

	export interface FullArticle {
		id: number;
		feedTitle: string;
		title: string;
		link: string;
		author: string | null;
		publishedAt: Date | null;
		excerpt: string | null;
		contentHtml: string | null;
		imageUrl: string | null;
		isRead: boolean;
		isSaved: boolean;
		tags?: TagRef[];
	}

	let {
		article = null,
		showBack = false,
		focusMode = true,
		tagHref,
		onTagClick,
		onBack,
		onFocusChange
	}: {
		article: FullArticle | null;
		/** True when the list is hidden (focus/reader-only view). */
		showBack?: boolean;
		/** Link for a tag chip: opens the article list filtered by that tag. */
		tagHref?: (tagId: number) => string;
		/** A tag chip was activated — the page reveals the article list. */
		onTagClick?: () => void;
		/** Focus mode: hide the list while reading. */
		focusMode?: boolean;
		onBack?: () => void;
		onFocusChange?: (enabled: boolean) => void;
	} = $props();

	function prettyDate(d: Date | string | null) {
		if (!d) return '';
		const date = d instanceof Date ? d : new Date(d);
		return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
	}

	let fulltextBusy = $state(false);
	let fulltextError = $state<string | null>(null);
	let tagsOpen = $state(false);
	let scrollEl: HTMLDivElement | null = $state(null);
	/** Hidden forms backing the mobile overflow menu (menu items can't post forms). */
	let saveForm: HTMLFormElement | null = $state(null);
	let readForm: HTMLFormElement | null = $state(null);

	function sendEvent(id: number, kind: string, value = 0) {
		if (!browser) return;
		fetch(`/api/articles/${id}/event`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kind, value }),
			keepalive: true
		}).catch(() => undefined);
	}

	// Dwell + scroll-depth beacons feeding the Recommended feed. Runs only in
	// the browser; timers/listeners are torn down when the article changes.
	$effect(() => {
		const id = article?.id;
		if (!id || !browser) return;
		let maxPct = 0;
		let finishSent = false;
		const onScroll = () => {
			const el = scrollEl;
			if (!el) return;
			const range = el.scrollHeight - el.clientHeight;
			const pct = range > 0 ? Math.round((el.scrollTop / range) * 100) : 100;
			if (pct > maxPct && (pct >= maxPct + 10 || pct >= 85)) {
				maxPct = pct;
				sendEvent(id, 'scroll', pct);
			}
			if (pct >= 85 && !finishSent) {
				finishSent = true;
				sendEvent(id, 'finish');
			}
		};
		const dwellTimer = window.setInterval(() => {
			if (document.visibilityState === 'visible') sendEvent(id, 'dwell', 15000);
		}, 15000);
		const el = scrollEl;
		el?.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			window.clearInterval(dwellTimer);
			el?.removeEventListener('scroll', onScroll);
		};
	});

	const textLength = $derived((article?.contentHtml ?? '').replace(/<[^>]+>/g, '').trim().length);
	const showFulltext = $derived(article != null && (textLength === 0 || textLength < 500));

	async function loadFulltext() {
		if (!article || fulltextBusy) return;
		fulltextBusy = true;
		fulltextError = null;
		try {
			const res = await fetch(`/api/articles/${article.id}/fulltext`, { method: 'POST' });
			if (!res.ok) throw new Error(`scrape ${res.status}`);
			window.location.reload();
		} catch {
			fulltextError = 'Could not fetch the full text. Try the original instead.';
		} finally {
			fulltextBusy = false;
		}
	}
</script>

<div class="flex min-h-0 flex-1 flex-col bg-background">
	{#if !article}
		<div class="flex flex-1 items-center justify-center p-8">
			<Empty.Root>
				<Empty.Header>
					<Empty.Media variant="icon"><BookOpen /></Empty.Media>
					<Empty.Title>Select a story</Empty.Title>
					<Empty.Description>Choose an article from the list to read it here.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		</div>
	{:else}
		<div class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
			<div class="flex min-w-0 flex-1 items-center gap-1">
				{#if showBack}
					<Button
						variant="ghost"
						size="icon-sm"
						onclick={onBack}
						aria-label="Close article and show list"
						title="Close article and show list"
						data-reader-back
					>
						<ChevronLeft />
					</Button>
				{/if}
				<span class="max-w-full min-w-0 truncate text-sm text-muted-foreground"
					>{article.feedTitle}</span
				>
				{#if article.author}
					<p class="hidden min-w-0 truncate text-xs text-muted-foreground lg:block">
						by {article.author}
					</p>
				{/if}
			</div>
			<div class="hidden shrink-0 items-center gap-1 sm:flex">
				<Toggle
					variant="outline"
					size="sm"
					aria-label="Focus mode: hide the list while reading"
					title={focusMode ? 'Focus mode on' : 'Focus mode off'}
					pressed={focusMode}
					onPressedChange={(v) => onFocusChange?.(v)}
				>
					{#if focusMode}<Eye />{:else}<EyeOff />{/if}
					<span class="hidden sm:inline">Focus</span>
				</Toggle>
				<form method="POST" action="/?/toggleSaved" use:enhance>
					<input type="hidden" name="id" value={article.id} />
					<Button variant="ghost" size="icon-sm" type="submit" aria-label="Save for later">
						{#if article.isSaved}<BookmarkCheck />{:else}<Bookmark />{/if}
					</Button>
				</form>
				<form method="POST" action="/?/markRead" use:enhance>
					<input type="hidden" name="id" value={article.id} />
					<Button variant="ghost" size="icon-sm" type="submit" aria-label="Mark as read">
						<CheckCheck />
					</Button>
				</form>
				<Button
					variant="ghost"
					size="icon-sm"
					onclick={() => (tagsOpen = true)}
					aria-label="Edit tags"
					title="Edit tags"
				>
					<Tag />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					href={article.link}
					target="_blank"
					aria-label="Open original"
				>
					<ExternalLink />
				</Button>
			</div>
			<!-- Phones get focus + one overflow menu instead of five icon buttons. -->
			<div class="flex shrink-0 items-center gap-1 sm:hidden">
				<Toggle
					variant="outline"
					size="sm"
					aria-label="Focus mode: hide the list while reading"
					title={focusMode ? 'Focus mode on' : 'Focus mode off'}
					pressed={focusMode}
					onPressedChange={(v) => onFocusChange?.(v)}
				>
					{#if focusMode}<Eye />{:else}<EyeOff />{/if}
				</Toggle>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="ghost"
								size="icon-sm"
								aria-label="Article actions"
								title="Article actions"
							>
								<Ellipsis />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end">
						<DropdownMenu.Item onSelect={() => saveForm?.requestSubmit()}>
							{#if article.isSaved}<BookmarkCheck />{:else}<Bookmark />{/if}
							{article.isSaved ? 'Saved for later' : 'Save for later'}
						</DropdownMenu.Item>
						<DropdownMenu.Item onSelect={() => readForm?.requestSubmit()}>
							<CheckCheck />
							Mark as read
						</DropdownMenu.Item>
						<DropdownMenu.Item onSelect={() => (tagsOpen = true)}>
							<Tag />
							Edit tags
						</DropdownMenu.Item>
						<DropdownMenu.Item onSelect={() => window.open(article.link, '_blank', 'noopener')}>
							<ExternalLink />
							Open original
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>
		</div>
		<!-- Menu-only posts: DropdownMenu items can't submit forms directly. -->
		<form method="POST" action="/?/toggleSaved" use:enhance class="hidden" bind:this={saveForm}>
			<input type="hidden" name="id" value={article.id} />
		</form>
		<form method="POST" action="/?/markRead" use:enhance class="hidden" bind:this={readForm}>
			<input type="hidden" name="id" value={article.id} />
		</form>
		<div class="min-h-0 flex-1 overflow-y-auto" bind:this={scrollEl}>
			<article
				class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pt-6 pb-12 sm:px-8 sm:pt-10 md:px-10"
			>
				<h1 class="text-2xl font-bold text-balance break-words text-foreground sm:text-3xl">
					{article.title}
				</h1>
				<p class="text-sm text-muted-foreground">
					{article.feedTitle}{#if article.author}
						by {article.author}{/if} · {prettyDate(article.publishedAt)}
				</p>
				{#if (article.tags ?? []).length > 0}
					<div class="flex flex-wrap gap-1.5">
						{#each article.tags ?? [] as t (t.id)}
							{#if tagHref}
								<Badge
									variant="secondary"
									href={tagHref(t.id)}
									title={`Show all stories tagged ${t.name}`}
									onclick={() => onTagClick?.()}
									class="max-w-full justify-start"
								>
									<span class="min-w-0 truncate">{t.name}</span>
								</Badge>
							{:else}
								<Badge variant="secondary" class="max-w-full justify-start"
									><span class="min-w-0 truncate">{t.name}</span></Badge
								>
							{/if}
						{/each}
					</div>
				{/if}
				<Separator />
				{#if article.imageUrl}
					<img
						src={article.imageUrl}
						alt={article.title}
						class="aspect-video w-full rounded-xl bg-muted object-cover"
					/>
				{/if}
				{#if article.contentHtml}
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<div
						class="prose max-w-none text-base leading-relaxed text-foreground prose-neutral sm:text-sm dark:prose-invert"
					>
						{@html article.contentHtml}
					</div>
				{:else if article.excerpt}
					<p class="text-base leading-relaxed text-foreground">{article.excerpt}</p>
				{/if}
				{#if showFulltext}
					<div class="flex flex-col gap-2">
						<div>
							<Button variant="outline" onclick={loadFulltext} disabled={fulltextBusy}>
								{fulltextBusy ? 'Fetching full text…' : 'Load full text'}
							</Button>
						</div>
						{#if fulltextError}
							<p class="text-sm text-destructive">{fulltextError}</p>
						{:else}
							<p class="text-xs text-muted-foreground">
								This feed only ships an excerpt — fetch the full article from the original site.
							</p>
						{/if}
					</div>
				{/if}
				<div class="pt-4">
					<Button variant="outline" href={article.link} target="_blank">
						<ExternalLink /> Read original
					</Button>
				</div>
			</article>
		</div>
		<EditTagsDialog
			bind:open={tagsOpen}
			articleId={article.id}
			articleTitle={article.title}
			initial={(article.tags ?? []).map((t) => t.name).join(', ')}
		/>
	{/if}
</div>
