<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { enhance } from '$app/forms';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Resizable from '$lib/components/ui/resizable/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { shouldShowFocus, type ArticleView } from '$lib/article.js';
	import ArticleBrowser from '$lib/components/article-browser.svelte';
	import ArticleList from '$lib/components/article-list.svelte';
	import ArticleViewToggle from '$lib/components/article-view-toggle.svelte';
	import MobileBottomNav from '$lib/components/mobile-bottom-nav.svelte';
	import ReaderPane from '$lib/components/reader-pane.svelte';
	import SearchBox from '$lib/components/search-box.svelte';
	import { RefreshCw, Shuffle } from '@lucide/svelte';

	const VIEW_BASE = 'charlens:article-view';
	const PANEL_BASE = 'charlens:article-panel-open';
	const FOCUS_BASE = 'charlens:focus-mode';

	let { data } = $props();

	// Reader prefs are device-local but keyed by user so accounts sharing a
	// browser never leak view/panel/focus state into each other.
	const userKey = $derived(data.user?.id ?? 'anonymous');
	const viewKey = $derived(`${VIEW_BASE}:${userKey}`);
	const panelKey = $derived(`${PANEL_BASE}:${userKey}`);
	const focusKey = $derived(`${FOCUS_BASE}:${userKey}`);

	function prefsUserId() {
		return data.user?.id ?? 'anonymous';
	}

	function isArticleView(value: string | null): value is ArticleView {
		return value === 'list' || value === 'grid' || value === 'compact';
	}

	// Synchronous browser reads so the first client render already uses the
	// saved prefs — reading them in `onMount` instead paints the defaults
	// first and visibly flickers into the saved view/panel/focus state.
	function readStoredView(): ArticleView {
		if (!browser) return 'list';
		try {
			const stored = localStorage.getItem(`${VIEW_BASE}:${prefsUserId()}`);
			if (isArticleView(stored)) return stored;
		} catch {
			// Storage unavailable (private mode, blocked) — use the default.
		}
		return 'list';
	}

	function readStoredPanel(): boolean {
		if (!browser) return true;
		try {
			if (localStorage.getItem(`${PANEL_BASE}:${prefsUserId()}`) === 'closed') return false;
		} catch {
			// Storage unavailable — use the default.
		}
		return true;
	}

	function readStoredFocus(): boolean {
		if (!browser) return true;
		try {
			if (localStorage.getItem(`${FOCUS_BASE}:${prefsUserId()}`) === 'off') return false;
		} catch {
			// Storage unavailable — use the default.
		}
		return true;
	}

	let view = $state<ArticleView>(readStoredView());
	let panelOpen = $state(readStoredPanel());
	let focusMode = $state(readStoredFocus());
	// False during SSR and the first client paint: the view-dependent lists
	// render a neutral skeleton until the saved prefs are confirmed, so the
	// page never flashes the default layout before swapping to the saved one.
	let prefsRestored = $state(false);

	/** Explicit `?article=` param — distinguishes "article in view" from the server's first-article preview. */
	const articleParam = $derived($page.url.searchParams.get('article'));
	const hasArticleParam = $derived(articleParam !== null);
	const hasSelected = $derived(data.selected != null);
	const wantFocus = $derived(shouldShowFocus({ focusMode, hasArticleParam, hasSelected }));

	// Phones always land on the list unless an article was explicitly opened:
	// the desktop "preview" (first article beside the list) has no room and
	// no way back below md. Read synchronously so the first client paint is
	// already correct; SSR renders the list (mobile-first, no mismatch).
	const desktopQuery = '(min-width: 768px)';
	let isDesktop = $state(browser ? window.matchMedia(desktopQuery).matches : false);

	/** The reader owns the main pane only for an explicit selection on phones. */
	const showReader = $derived(
		(hasArticleParam || (panelOpen && isDesktop)) && data.selected != null
	);

	onMount(() => {
		// Prefs were already read synchronously during init so the first
		// client render uses them; flipping the flag here swaps the loading
		// skeletons for the real lists with no intermediate wrong-view paint.
		prefsRestored = true;

		function onKeyDown(e: KeyboardEvent) {
			if (e.key === 'Escape' && hasArticleParam) {
				e.preventDefault();
				goBack();
			}
		}
		window.addEventListener('keydown', onKeyDown);
		const mq = window.matchMedia(desktopQuery);
		function onViewportChange(e: MediaQueryListEvent) {
			isDesktop = e.matches;
		}
		mq.addEventListener('change', onViewportChange);
		return () => {
			window.removeEventListener('keydown', onKeyDown);
			mq.removeEventListener('change', onViewportChange);
		};
	});

	$effect(() => {
		if (!prefsRestored) return;
		localStorage.setItem(viewKey, view);
		localStorage.setItem(panelKey, panelOpen ? 'open' : 'closed');
		localStorage.setItem(focusKey, focusMode ? 'on' : 'off');
	});

	// Focus automation: the article list is shown on its own when no article is
	// in view; selecting an article collapses to sidebar + reader.
	$effect(() => {
		if (!prefsRestored) return;
		// Read reactively so the effect re-runs on navigation.
		if (wantFocus && panelOpen) panelOpen = false;
	});

	let prevFocusMode = $state<boolean | undefined>(undefined);
	$effect(() => {
		// Toggling focus mode off while in reader-only view re-opens the list.
		if (!prefsRestored) return;
		const mode = focusMode;
		if (prevFocusMode && !mode && !panelOpen) panelOpen = true;
		prevFocusMode = mode;
	});

	type PaneApi = {
		collapse: () => void;
		expand: () => void;
		isCollapsed: () => boolean;
		isExpanded: () => boolean;
	};
	let listPane = $state<PaneApi | null>(null);

	$effect(() => {
		const pane = listPane;
		if (!pane) return;
		if (panelOpen && pane.isCollapsed()) pane.expand();
		else if (!panelOpen && pane.isExpanded()) pane.collapse();
	});

	// A drag or double-click on the divider collapses the shell too — keep `panelOpen`
	// in sync via the pane's transition callbacks (onLayoutChange would fire
	// continuously mid-animation and fight programmatic collapse/expand).
	// When the list is collapsed and an article is selected the right pane shows
	// the reader-only focus view; with no article it shows the full-width list.
	let paneInitDone = false;
	function handlePaneExpand() {
		// First notification is the initial layout, not user intent.
		if (!paneInitDone || !prefsRestored) {
			paneInitDone = true;
			return;
		}
		panelOpen = true;
		// Pulling the list open by hand is explicit intent: leave focus mode so
		// automation doesn't slam it shut again. Picking another story re-arms it.
		if (wantFocus) focusMode = false;
	}

	function handlePaneCollapse() {
		if (!paneInitDone || !prefsRestored) {
			paneInitDone = true;
			return;
		}
		panelOpen = false;
	}

	/** Close the article and show the list only (sidebar + full-width list). */
	function goBack() {
		const url = new URL($page.url);
		url.searchParams.delete('article');
		panelOpen = false;
		goto(`${url.pathname}?${url.searchParams.toString()}`, { keepFocus: true }).then(() => {
			// Land keyboard users on the list heading.
			requestAnimationFrame(() => {
				document.querySelector<HTMLElement>('[data-article-list-heading]')?.focus();
			});
		});
	}

	/**
	 * Tag chips on an article open the list scoped to that tag: the previous
	 * scope (feed/collection/smart view/search) is dropped so the tag view is
	 * unambiguous, and the article is cleared so the list shows on its own.
	 */
	function tagFilterHref(tagId: number) {
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

	// Reading a story in focus mode hides the list; activating one of its tag
	// chips asks for it back. The expand only happens once the tag URL has
	// landed: doing it earlier is undone by the focus automation, which still
	// sees the old `?article=` in the URL.
	let tagListRequested = false;
	afterNavigate(() => {
		if (!tagListRequested) return;
		tagListRequested = false;
		panelOpen = true;
	});

	function setFocusMode(enabled: boolean) {
		focusMode = enabled;
		const selected = data.selected;
		if (enabled && selected) {
			panelOpen = false;
			// Focusing while only previewing (no explicit selection) makes that
			// story the selection first, so the toggle always acts on screen.
			if (!hasArticleParam) {
				const url = new URL($page.url);
				url.searchParams.set('article', String(selected.id));
				goto(`${url.pathname}?${url.searchParams.toString()}`, { keepFocus: true });
			}
		}
	}

	const unreadCount = $derived(data.articles.filter((a) => !a.isRead).length);
	const isRecommended = $derived(data.filter === 'recommended');

	/** New exploration mix for Recommended: fresh seed forces reload + rerank. */
	function reshuffle() {
		const url = new URL($page.url);
		url.searchParams.set('shuffle', String(Date.now()));
		goto(`${url.pathname}?${url.searchParams.toString()}`, { keepFocus: true });
	}

	const feedTitle = $derived.by(() => {
		if (data.feedId) {
			const found = data.articles[0];
			return found?.feedTitle ?? 'Feed';
		}
		if (data.viewId) {
			const view = (data.collections ?? []).find((c) => c.id === data.viewId);
			return view?.name ?? 'Smart view';
		}
		if (data.collectionId) {
			const coll = (data.collections ?? []).find((c) => c.id === data.collectionId);
			return coll?.name ?? 'Collection';
		}
		if (data.tagId) {
			const tagged = (data.tags ?? []).find((t) => t.id === data.tagId);
			return tagged ? `#${tagged.name}` : 'Tag';
		}
		if (data.filter === 'today') return 'Today';
		if (data.filter === 'saved') return 'Read later';
		if (data.filter === 'recommended') return 'Recommended';
		return 'All stories';
	});
</script>

<svelte:head>
	<title>{feedTitle} · charlens</title>
</svelte:head>

<div class="flex h-dvh min-h-0 min-w-0 bg-background text-foreground">
	<Resizable.PaneGroup direction="horizontal">
		<Resizable.Pane
			order={1}
			defaultSize={32}
			minSize={20}
			maxSize={50}
			collapsible
			collapsedSize={0}
			bind:this={listPane}
			onExpand={handlePaneExpand}
			onCollapse={handlePaneCollapse}
			class="flex min-h-0 flex-col bg-card max-md:hidden"
		>
			<div class="flex items-center gap-2 border-b border-border p-4">
				<SearchBox />
				<ArticleViewToggle bind:view />
			</div>
			<div class="flex items-start justify-between gap-2 border-b border-border px-5 py-4">
				<div class="min-w-0">
					<h1 class="truncate text-lg font-bold text-foreground">{feedTitle}</h1>
					<p class="text-xs text-muted-foreground">
						{data.articles.length} stories · {unreadCount} unread
					</p>
				</div>
				<div class="flex items-center gap-1">
					{#if isRecommended}
						<Button
							variant="ghost"
							size="icon-sm"
							type="button"
							aria-label="Shuffle recommendations"
							onclick={reshuffle}
						>
							<Shuffle />
						</Button>
					{/if}
					<form method="POST" action="/?/refresh" use:enhance>
						<Button variant="ghost" size="icon-sm" type="submit" aria-label="Refresh feeds">
							<RefreshCw />
						</Button>
					</form>
				</div>
			</div>
			{#if prefsRestored}
				<ArticleList
					articles={data.articles}
					{view}
					gridClass="grid-cols-1"
					onSelect={() => {
						if (focusMode) panelOpen = false;
					}}
				/>
			{:else}
				<!-- Neutral placeholder: same rhythm as the list rows, but with no
				layout of its own so no saved view flashes through first. -->
				<div class="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-5" aria-hidden="true">
					<Skeleton class="h-16 w-full" />
					<Skeleton class="h-16 w-full" />
					<Skeleton class="h-16 w-full" />
					<Skeleton class="h-16 w-full" />
					<Skeleton class="h-16 w-full" />
				</div>
			{/if}
		</Resizable.Pane>
		<Resizable.Handle class="max-md:hidden" withHandle />
		<Resizable.Pane order={2} minSize={30} class="flex min-h-0 min-w-0 flex-col">
			{#if showReader}
				<ReaderPane
					article={data.selected}
					showBack={!panelOpen && hasArticleParam}
					{focusMode}
					tagHref={tagFilterHref}
					onTagClick={() => (tagListRequested = true)}
					onBack={goBack}
					onFocusChange={setFocusMode}
				/>
			{:else}
				<ArticleBrowser
					articles={data.articles}
					title={feedTitle}
					bind:view
					{focusMode}
					ready={prefsRestored}
					onExpand={() => (panelOpen = true)}
					onSelect={() => {
						if (!focusMode) panelOpen = true;
					}}
				/>
			{/if}
			{#if !hasArticleParam}
				<!-- Reader hides this bar for full-height reading; list and preview keep thumb-reach nav. -->
				<MobileBottomNav />
			{/if}
		</Resizable.Pane>
	</Resizable.PaneGroup>
</div>
