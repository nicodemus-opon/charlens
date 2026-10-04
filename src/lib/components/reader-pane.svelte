<script lang="ts">
	import { browser } from '$app/environment';
	import { enhance } from '$app/forms';
	import { prefersReducedMotion } from 'svelte/motion';
	import { cubicOut } from 'svelte/easing';
	import { fly } from 'svelte/transition';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import {
		BookOpen,
		Bookmark,
		BookmarkCheck,
		CheckCheck,
		ChevronLeft,
		ExternalLink,
		Eye,
		EyeOff,
		Tag
	} from '@lucide/svelte';
	import { Toggle } from '$lib/components/ui/toggle/index.js';
	import ArticleImage from '$lib/components/article-image.svelte';
	import ArticleFeedbackMenu from '$lib/components/article-feedback-menu.svelte';
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
		onFocusChange,
		readerFontSize = 'comfortable',
		readerWidth = 'narrow',
		openLinksNewTab = true,
		autoLoadFullText = false,
		telemetryEnabled = true,
		showFeedback = false
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
		readerFontSize?: 'compact' | 'comfortable' | 'large';
		readerWidth?: 'narrow' | 'wide';
		openLinksNewTab?: boolean;
		autoLoadFullText?: boolean;
		telemetryEnabled?: boolean;
		/** True on Recommended: header gets the "less like this" menu. */
		showFeedback?: boolean;
	} = $props();

	const linkTarget = $derived(openLinksNewTab ? '_blank' : undefined);

	function prettyDate(d: Date | string | null) {
		if (!d) return '';
		const date = d instanceof Date ? d : new Date(d);
		return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
	}

	/**
	 * Feed body HTML ({@html} below) often embeds remote images that are dead
	 * (hotlink protection, expired hosts). Remove them so the reader never
	 * shows native broken-image boxes.
	 */
	function hideBrokenImages(node: HTMLElement) {
		const cleanups: Array<() => void> = [];
		const watch = (img: HTMLImageElement) => {
			if (img.complete && img.naturalWidth === 0) {
				img.remove();
				return;
			}
			const onError = () => img.remove();
			img.addEventListener('error', onError, { once: true });
			cleanups.push(() => img.removeEventListener('error', onError));
		};
		node.querySelectorAll('img').forEach(watch);
		return {
			destroy() {
				for (const cleanup of cleanups) cleanup();
			}
		};
	}

	let fulltextBusy = $state(false);
	let fulltextError = $state<string | null>(null);
	let tagsOpen = $state(false);
	let scrollEl: HTMLDivElement | null = $state(null);
	/** Hidden forms backing the mobile toolbar (buttons can't post forms). */
	let saveForm: HTMLFormElement | null = $state(null);
	let readForm: HTMLFormElement | null = $state(null);

	// Edge-swipe back: a short rightward swipe starting at the left edge
	// leaves the reader. Edge-only so scrolling and selection never fight it.
	const EDGE_PX = 32;
	const SWIPE_DX = 72;
	const SWIPE_DY = 48;
	const SWIPE_MS = 500;
	let swipeStart: { x: number; y: number; t: number } | null = null;
	function onTouchStart(e: TouchEvent) {
		const t = e.touches[0];
		if (t.clientX < EDGE_PX) swipeStart = { x: t.clientX, y: t.clientY, t: performance.now() };
		else swipeStart = null;
	}
	function onTouchEnd(e: TouchEvent) {
		const s = swipeStart;
		swipeStart = null;
		if (!s || !showBack) return;
		const t = e.changedTouches[0];
		const dx = t.clientX - s.x;
		const dy = Math.abs(t.clientY - s.y);
		if (dx > SWIPE_DX && dy < SWIPE_DY && performance.now() - s.t < SWIPE_MS) onBack?.();
	}

	function sendEvent(id: number, kind: string, value = 0) {
		if (!browser || !telemetryEnabled) return;
		fetch(`/api/articles/${id}/event`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kind, value }),
			keepalive: true
		}).catch(() => undefined);
	}

	// Dwell + scroll-depth beacons feeding the Recommended feed. Runs only in
	// the browser; timers/listeners are torn down when the article changes.
	// Disabled entirely when the user opts out in Settings → privacy.
	$effect(() => {
		const id = article?.id;
		if (!id || !browser || !telemetryEnabled) return;
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
	// Entrance-only bridging for article swaps: prevents a jarring teleport when
	// the reader content changes. Near-imperceptible by design (180ms ease-out,
	// transform + opacity only); no exit animation so rapid navigation retargets
	// cleanly. Reduced-motion users get an instant swap.
	const reduceMotion = $derived(prefersReducedMotion.current);

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

	// Auto-load full text once per article when the user opts in (Settings
	// → auto-load). Guarded by showFulltext so full articles never refetch.
	let autoLoadedFor: number | null = $state(null);
	$effect(() => {
		const id = article?.id;
		if (!id || !autoLoadFullText || !showFulltext || fulltextBusy) return;
		if (autoLoadedFor === id) return;
		autoLoadedFor = id;
		void loadFulltext();
	});
</script>

<div
	class="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background"
	role="region"
	aria-label="Article"
	bind:this={scrollEl}
	ontouchstart={onTouchStart}
	ontouchend={onTouchEnd}
>
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
		<div
			class="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/80 px-4 backdrop-blur"
		>
			<div class="flex min-w-0 flex-1 items-center gap-1">
				{#if showBack}
					<Button
						variant="ghost"
						size="icon-sm"
						class="min-h-11 min-w-11"
						onclick={onBack}
						aria-label="Close article and show list"
						title="Close article and show list"
						data-reader-back
					>
						<ChevronLeft />
					</Button>
				{/if}
				<span class="max-w-full min-w-0 truncate text-sm text-muted-foreground max-sm:hidden"
					>{article.feedTitle}</span
				>
				{#if article.author}
					<p class="hidden min-w-0 truncate text-xs text-muted-foreground lg:block">
						by {article.author}
					</p>
				{/if}
			</div>
			<Toggle
				variant="outline"
				size="sm"
				class="min-h-11 min-w-11 shrink-0 sm:min-h-0 sm:min-w-0"
				aria-label="Focus mode: hide the list while reading"
				title={focusMode ? 'Focus mode on' : 'Focus mode off'}
				pressed={focusMode}
				onPressedChange={(v) => onFocusChange?.(v)}
			>
				{#if focusMode}<Eye />{:else}<EyeOff />{/if}
				<span class="hidden sm:inline">Focus</span>
			</Toggle>
			<div class="hidden shrink-0 items-center gap-1 sm:flex">
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
				{#if showFeedback}
					<ArticleFeedbackMenu
						articleId={article.id}
						isSaved={article.isSaved}
						isRead={article.isRead}
						hoverOnly={false}
					/>
				{/if}
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
					target={linkTarget}
					rel="noopener"
					aria-label="Open original"
				>
					<ExternalLink />
				</Button>
			</div>
		</div>
		<!-- Toolbar-only posts: toolbar buttons can't submit forms directly. -->
		<form method="POST" action="/?/toggleSaved" use:enhance class="hidden" bind:this={saveForm}>
			<input type="hidden" name="id" value={article.id} />
		</form>
		<form method="POST" action="/?/markRead" use:enhance class="hidden" bind:this={readForm}>
			<input type="hidden" name="id" value={article.id} />
		</form>
		<div class="min-h-0 flex-1">
			{#key article.id}
				<div
					in:fly={{ y: reduceMotion ? 0 : 8, duration: reduceMotion ? 0 : 180, easing: cubicOut }}
				>
					<article
						class={readerWidth === 'wide'
							? 'mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pt-6 pb-24 sm:px-8 sm:pt-10 sm:pb-12 md:px-10'
							: 'mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pt-6 pb-24 sm:px-8 sm:pt-10 sm:pb-12 md:px-10'}
					>
						<h1 class="text-3xl font-bold text-balance break-words text-foreground">
							{article.title}
						</h1>
						<p class="text-sm text-muted-foreground">
							{article.feedTitle}{#if article.author}
								by {article.author}{/if}, {prettyDate(article.publishedAt)}
						</p>
						{#if (article.tags ?? []).length > 0}
							<div class="flex flex-wrap gap-1.5 max-sm:hidden">
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
						<Separator class="max-sm:hidden" />
						<ArticleImage
							seed={{ id: article.id, feedTitle: article.feedTitle, title: article.title }}
							src={article.imageUrl}
							alt={article.title}
							class="aspect-video w-full rounded-none sm:rounded-xl"
						/>
						{#if article.contentHtml}
							<!-- eslint-disable-next-line svelte/no-at-html-tags -->
							<div
								use:hideBrokenImages
								class={readerFontSize === 'compact'
									? 'prose max-w-none text-sm leading-relaxed text-foreground prose-neutral dark:prose-invert'
									: readerFontSize === 'large'
										? 'prose prose-lg max-w-none leading-loose text-foreground prose-neutral dark:prose-invert'
										: 'prose max-w-none text-base leading-relaxed text-foreground prose-neutral sm:text-sm dark:prose-invert'}
							>
								{@html article.contentHtml}
							</div>
						{:else if article.excerpt}
							<p
								class={readerFontSize === 'compact'
									? 'font-serif text-sm leading-relaxed text-foreground'
									: readerFontSize === 'large'
										? 'font-serif text-lg leading-loose text-foreground'
										: 'font-serif text-base leading-relaxed text-foreground'}
							>
								{article.excerpt}
							</p>
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
										This feed only ships an excerpt. Fetch the full article from the original site.
									</p>
								{/if}
							</div>
						{/if}
						<div class="hidden pt-4 sm:block">
							<Button variant="outline" href={article.link} target={linkTarget} rel="noopener">
								<ExternalLink /> Read original
							</Button>
						</div>
					</article>
				</div>
			{/key}
		</div>
		<!-- Thumb-reach toolbar (phones): icon-only primary actions, safe-area
			padded. Desktop keeps its top-bar icon row. -->
		<div
			class="sticky bottom-0 z-10 flex shrink-0 items-stretch gap-1 border-t border-border bg-background/80 px-2 pt-2 pb-safe backdrop-blur sm:hidden"
			role="toolbar"
			aria-label="Article actions"
		>
			<Button
				variant="ghost"
				onclick={() => saveForm?.requestSubmit()}
				aria-label={article.isSaved ? 'Saved for later' : 'Save for later'}
				aria-pressed={article.isSaved}
				class="min-h-11 min-w-0 flex-1"
			>
				{#if article.isSaved}<BookmarkCheck />{:else}<Bookmark />{/if}
			</Button>
			<Button
				variant="ghost"
				onclick={() => readForm?.requestSubmit()}
				aria-label="Mark as read"
				class="min-h-11 min-w-0 flex-1"
			>
				<CheckCheck />
			</Button>
			<Button
				variant="ghost"
				onclick={() => (tagsOpen = true)}
				aria-label="Edit tags"
				class="min-h-11 min-w-0 flex-1"
			>
				<Tag />
			</Button>
			<Button
				variant="ghost"
				href={article.link}
				target={linkTarget}
				rel="noopener"
				aria-label="Open original"
				class="min-h-11 min-w-0 flex-1"
			>
				<ExternalLink />
			</Button>
		</div>
		<EditTagsDialog
			bind:open={tagsOpen}
			articleId={article.id}
			articleTitle={article.title}
			initial={(article.tags ?? []).map((t) => t.name).join(', ')}
		/>
	{/if}
</div>
