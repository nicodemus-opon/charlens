<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { enhance } from '$app/forms';
	import { afterNavigate, goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Resizable from '$lib/components/ui/resizable/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { shouldShowFocus, type ArticleView } from '$lib/article.js';
	import { defaultViewForScope, getViewScopeKey } from '$lib/view-prefs.js';
	import { settingsStore } from '$lib/settings.svelte.js';
	import ArticleBrowser from '$lib/components/article-browser.svelte';
	import ArticleList from '$lib/components/article-list.svelte';
	import ArticleViewToggle from '$lib/components/article-view-toggle.svelte';
	import MobileBottomNav from '$lib/components/mobile-bottom-nav.svelte';
	import ReaderPane from '$lib/components/reader-pane.svelte';
	import SearchBox from '$lib/components/search-box.svelte';
	import { shortcutsState } from '$lib/shortcuts.svelte.js';
	import { RefreshCw, Shuffle, CheckCheck } from '@lucide/svelte';

	const VIEW_BASE = 'charlens:article-view';
	const PANEL_BASE = 'charlens:article-panel-open';
	const FOCUS_BASE = 'charlens:focus-mode';

	let { data } = $props();

	// Reader prefs are device-local but keyed by user so accounts sharing a
	// browser never leak view/panel/focus state into each other. Article
	// layouts persist per scope in the DB (`user_view_pref`); the legacy
	// global localStorage key below is only a one-time fallback for scopes
	// without a saved pref.
	const userKey = $derived(data.user?.id ?? 'anonymous');
	const panelKey = $derived(`${PANEL_BASE}:${userKey}`);
	const focusKey = $derived(`${FOCUS_BASE}:${userKey}`);

	function prefsUserId() {
		return data.user?.id ?? 'anonymous';
	}

	function isArticleView(value: unknown): value is ArticleView {
		return value === 'list' || value === 'grid' || value === 'compact' || value === 'magazine';
	}

	function readLegacyView(): ArticleView | null {
		if (!browser) return null;
		try {
			const stored = localStorage.getItem(`${VIEW_BASE}:${prefsUserId()}`);
			if (isArticleView(stored)) return stored;
		} catch {
			// Storage unavailable (private mode, blocked) — no fallback.
		}
		return null;
	}

	/** Effective layout for a scope: saved pref, else the account default
	 * view from Settings (`defaultView`), with the magazine default kept for
	 * Today / Read later / Recommended when the account default is untouched,
	 * else the legacy global as fallback. */
	function viewForScope(scope: string, prefs: Record<string, unknown>): ArticleView {
		const saved = prefs[scope];
		if (isArticleView(saved)) return saved;
		if (settingsStore.ready) {
			const accountDefault = settingsStore.get('defaultView');
			if (isArticleView(accountDefault)) {
				// Preserve the editorial magazine default for the front-page
				// scopes unless the user picked a different account default.
				if (accountDefault !== 'list') return accountDefault;
				if (defaultViewForScope(scope) === 'magazine') return 'magazine';
				return accountDefault;
			}
		}
		if (defaultViewForScope(scope) === 'magazine') return 'magazine';
		return readLegacyView() ?? 'list';
	}

	function initialPrefs(): Record<string, ArticleView> {
		const prefs: Record<string, ArticleView> = {};
		for (const [scope, view] of Object.entries(data.viewPrefs ?? {})) {
			if (isArticleView(view)) prefs[scope] = view;
		}
		return prefs;
	}

	function initialScope(): string {
		return (
			data.viewScope ??
			getViewScopeKey({
				filter: data.filter,
				feedId: data.feedId,
				collectionId: data.collectionId,
				viewId: data.viewId,
				tagId: data.tagId,
				query: data.query
			})
		);
	}

	// Synchronous browser reads so the first client render already uses the
	// saved prefs — reading them in `onMount` instead paints the defaults
	// first and visibly flickers into the saved view/panel/focus state.
	const bootPrefs = initialPrefs();
	const bootScope = initialScope();
	function bootView(): ArticleView {
		return viewForScope(bootScope, bootPrefs);
	}

	function readStoredPanel(): boolean {
		if (!browser) return true;
		try {
			if (localStorage.getItem(`${PANEL_BASE}:${prefsUserId()}`) === 'closed') return false;
			if (localStorage.getItem(`${PANEL_BASE}:${prefsUserId()}`) === 'open') return true;
		} catch {
			// Storage unavailable — use the default.
		}
		if (settingsStore.ready) return Boolean(settingsStore.get('panelDefaultOpen'));
		const serverDefault = (data as { settings?: Record<string, unknown> }).settings
			?.panelDefaultOpen;
		if (typeof serverDefault === 'boolean') return serverDefault;
		return true;
	}

	function readStoredFocus(): boolean {
		if (!browser) return true;
		try {
			if (localStorage.getItem(`${FOCUS_BASE}:${prefsUserId()}`) === 'off') return false;
			if (localStorage.getItem(`${FOCUS_BASE}:${prefsUserId()}`) === 'on') return true;
		} catch {
			// Storage unavailable — use the default.
		}
		if (settingsStore.ready) return Boolean(settingsStore.get('focusModeDefault'));
		const serverDefault = (data as { settings?: Record<string, unknown> }).settings
			?.focusModeDefault;
		if (typeof serverDefault === 'boolean') return serverDefault;
		return true;
	}

	let viewPrefs = $state<Record<string, ArticleView>>(bootPrefs);
	let view = $state<ArticleView>(bootView());
	let panelOpen = $state(readStoredPanel());
	let focusMode = $state(readStoredFocus());
	/** Scope the current `view` belongs to — switching scopes swaps the layout. */
	let lastScope = $state(bootScope);
	// Refresh-button feedback: spins the icon for the round trip only.
	let refreshing = $state(false);
	// Mark-all-read feedback: disables the button for the round trip only.
	let markingAll = $state(false);
	// Keyboard bulk triage submits this form; it only renders with unread stories.
	let markAllForm: HTMLFormElement | null = $state(null);
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
		if (!settingsStore.ready) {
			settingsStore.init(
				(data as { settings?: Record<string, unknown> }).settings ?? {},
				prefsUserId()
			);
		}
		// Re-resolve boot view/panel/focus once account settings are known.
		view = viewForScope(viewScope, viewPrefs);
		panelOpen = readStoredPanel();
		focusMode = readStoredFocus();
		prefsRestored = true;

		/** Story the single-key actions act on — explicit selection, else the preview. */
		function activeArticleId(): number | null {
			if (articleParam) {
				const id = Number(articleParam);
				if (Number.isFinite(id)) return id;
			}
			return data.selected?.id ?? null;
		}

		function openArticle(id: number) {
			const url = new URL($page.url);
			url.searchParams.set('article', String(id));
			goto(`${url.pathname}?${url.searchParams.toString()}`, { keepFocus: true });
		}

		/** Single-article keyboard actions post the matching form action, then refresh. */
		async function postArticleAction(action: 'toggleSaved', id: number) {
			const form = new FormData();
			form.set('id', String(id));
			try {
				await fetch(`?/${action}`, { method: 'POST', body: form });
				await invalidateAll();
			} catch (err) {
				console.error(`${action} failed`, err);
			}
		}

		/**
		 * Keyboard `m`: toggle read state. The action payload is
		 * devalue-encoded, so the new state is derived from the rendered row
		 * instead of the response. When the story ends up unread the selection
		 * advances — the loader auto-marks whatever is displayed, so staying
		 * put would instantly undo the toggle.
		 */
		async function toggleActiveRead(id: number) {
			const was = data.articles.find((a) => a.id === id)?.isRead ?? data.selected?.isRead ?? true;
			const form = new FormData();
			form.set('id', String(id));
			try {
				await fetch('?/toggleRead', { method: 'POST', body: form });
			} catch (err) {
				console.error('toggleRead failed', err);
				await invalidateAll();
				return;
			}
			if (was) {
				const idx = data.articles.findIndex((a) => a.id === id);
				const next = idx >= 0 ? data.articles[idx + 1] : undefined;
				if (next) {
					openArticle(next.id);
					return;
				}
				if (hasArticleParam) {
					const url = new URL($page.url);
					url.searchParams.delete('article');
					await goto(`${url.pathname}?${url.searchParams.toString()}`, { keepFocus: true });
					return;
				}
			}
			await invalidateAll();
		}

		function onKeyDown(e: KeyboardEvent) {
			if (e.key === 'Escape' && hasArticleParam) {
				e.preventDefault();
				goBack();
				return;
			}
			const target = e.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === 'INPUT' ||
					target.tagName === 'TEXTAREA' ||
					target.tagName === 'SELECT' ||
					target.isContentEditable)
			) {
				return;
			}
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			// The command palette and dialogs own the keyboard while open.
			if (document.querySelector('[role="dialog"]')) return;
			const list = data.articles;
			const activeId = activeArticleId();
			const activeIdx = activeId != null ? list.findIndex((a) => a.id === activeId) : -1;
			switch (e.key) {
				case 'j': {
					e.preventDefault();
					const next = list[Math.min(activeIdx + 1, list.length - 1)];
					if (next) openArticle(next.id);
					break;
				}
				case 'k': {
					e.preventDefault();
					const prev = list[Math.max(activeIdx - 1, 0)];
					if (prev) openArticle(prev.id);
					break;
				}
				case 'o': {
					if (!hasArticleParam && data.selected) {
						e.preventDefault();
						openArticle(data.selected.id);
					}
					break;
				}
				case 's': {
					if (activeId != null) {
						e.preventDefault();
						void postArticleAction('toggleSaved', activeId);
					}
					break;
				}
				case 'm': {
					if (activeId != null) {
						e.preventDefault();
						void toggleActiveRead(activeId);
					}
					break;
				}
				case 'A': {
					// Shift+A — e.key reports the shifted 'A'.
					if (e.shiftKey) {
						e.preventDefault();
						markAllForm?.requestSubmit();
					}
					break;
				}
				case '/': {
					e.preventDefault();
					document.querySelector<HTMLInputElement>('[data-search-input]')?.focus();
					break;
				}
				case '?': {
					e.preventDefault();
					shortcutsState.open = true;
					break;
				}
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

	/** Current feed scope — each scope remembers its own layout. */
	const viewScope = $derived(
		data.viewScope ??
			getViewScopeKey({
				filter: data.filter,
				feedId: data.feedId,
				collectionId: data.collectionId,
				viewId: data.viewId,
				tagId: data.tagId,
				query: data.query
			})
	);

	let saveTimer: ReturnType<typeof setTimeout> | undefined;

	// Switching scopes (sidebar, palette, bottom nav) swaps to that scope's
	// saved layout, or its default when never customized. Server prefs only
	// fill scopes not yet seen locally so an unsaved toggle never loses.
	$effect(() => {
		const serverPrefs = data.viewPrefs ?? {};
		for (const [scope, saved] of Object.entries(serverPrefs)) {
			if (isArticleView(saved) && viewPrefs[scope] === undefined) {
				viewPrefs[scope] = saved;
			}
		}
		const scope = viewScope;
		if (scope !== lastScope) {
			lastScope = scope;
			const next = viewPrefs[scope] ?? viewForScope(scope, viewPrefs);
			if (next !== view) view = next;
		}
	});

	$effect(() => {
		if (!prefsRestored) return;
		localStorage.setItem(panelKey, panelOpen ? 'open' : 'closed');
		localStorage.setItem(focusKey, focusMode ? 'on' : 'off');
		// Persisting the layout is scope-local: toggling the view saves it
		// for the current scope only, debounced so rapid toggles save once.
		const scope = viewScope;
		const current = view;
		if (viewPrefs[scope] === current) return;
		viewPrefs[scope] = current;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			const form = new FormData();
			form.set('scope', scope);
			form.set('view', current);
			fetch('?/setViewPref', { method: 'POST', body: form }).catch((e) =>
				console.error('view pref save failed', e)
			);
		}, 300);
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
		url.searchParams.delete('shuffle');
		url.searchParams.delete('deep');
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

	/** Deep exploration remix for Recommended: fresh seed + amplified slot. */
	function reshuffle() {
		const url = new URL($page.url);
		url.searchParams.set('shuffle', String(Date.now()));
		url.searchParams.set('deep', '1');
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

	// Account display settings (SSR-safe: layout payload first, live store after).
	function settingBool(key: string, fallback = true): boolean {
		if (settingsStore.ready) return Boolean(settingsStore.get(key as never));
		const server = (data as { settings?: Record<string, unknown> }).settings?.[key];
		if (typeof server === 'boolean') return server;
		return fallback;
	}
	function settingStr(key: string, fallback: string): string {
		if (settingsStore.ready) return String(settingsStore.get(key as never));
		const server = (data as { settings?: Record<string, unknown> }).settings?.[key];
		if (typeof server === 'string') return server;
		return fallback;
	}
	const showImages = $derived(settingBool('showImagesInList', true));
	const showExcerpts = $derived(settingBool('showExcerpts', true));
	const showMinutes = $derived(settingBool('showReadMinutes', true));
	const openLinksNewTab = $derived(settingBool('openLinksNewTab', true));
	const autoLoadFullText = $derived(settingBool('autoLoadFullText', false));
	const telemetryEnabled = $derived(settingBool('telemetryEnabled', true));
	const listDensity = $derived(settingStr('density', 'comfortable'));
	const readerDensity = $derived(listDensity === 'compact' ? 'compact' : 'comfortable') as
		'comfortable' | 'compact';
	const readerFontSize = $derived(
		settingStr('readerFontSize', 'comfortable') as 'compact' | 'comfortable' | 'large'
	);
	const readerWidth = $derived(settingStr('readerWidth', 'narrow') as 'narrow' | 'wide');
</script>

<svelte:head>
	<title>{feedTitle} charlens</title>
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
			<!-- paneforge forces overflow:hidden on the pane itself, so the
			scroll container must be an inner element (same as the reader /
			browser pane on the right). -->
			<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<div
					class="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card/80 px-4 backdrop-blur"
				>
					<SearchBox />
					<ArticleViewToggle bind:view />
				</div>
				<div
					class="sticky top-14 z-10 flex items-start justify-between gap-2 border-b border-border bg-card/80 px-5 py-4 backdrop-blur"
				>
					<div class="min-w-0">
						<h1 class="truncate text-lg font-bold text-foreground">{feedTitle}</h1>
						<p class="text-xs text-muted-foreground">
							{data.articles.length} stories, {unreadCount} unread
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
						{#if unreadCount > 0}
							<form
								method="POST"
								action="/?/markAllRead"
								bind:this={markAllForm}
								use:enhance={() => {
									markingAll = true;
									return async ({ update }) => {
										await update();
										markingAll = false;
									};
								}}
							>
								<Button
									variant="ghost"
									size="icon-sm"
									type="submit"
									disabled={markingAll}
									aria-label={`Mark all ${unreadCount} as read`}
									title="Mark all as read (Shift+A)"
								>
									<CheckCheck />
								</Button>
							</form>
						{/if}
						<form
							method="POST"
							action="/?/refresh"
							use:enhance={() => {
								refreshing = true;
								return async ({ update }) => {
									await update();
									refreshing = false;
								};
							}}
						>
							<Button variant="ghost" size="icon-sm" type="submit" aria-label="Refresh feeds">
								<RefreshCw class={refreshing ? 'animate-spin' : undefined} />
							</Button>
						</form>
					</div>
				</div>
				{#if prefsRestored}
					<!-- The side pane is too narrow for the front-page hero, so the
				magazine view falls back to cards here; the wide browser pane
				still renders the full magazine below. -->
					<ArticleList
						articles={data.articles}
						view={view === 'magazine' ? 'grid' : view}
						gridClass="grid-cols-1"
						{showImages}
						{showExcerpts}
						showReadMinutes={showMinutes}
						density={readerDensity}
						showFeedback={isRecommended}
						scrollable={false}
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
			</div>
		</Resizable.Pane>
		<Resizable.Handle class="max-md:hidden" withHandle />
		<Resizable.Pane order={2} minSize={30} class="relative flex min-h-0 min-w-0 flex-col">
			{#if showReader}
				<ReaderPane
					article={data.selected}
					showBack={!panelOpen && hasArticleParam}
					{focusMode}
					{readerFontSize}
					{readerWidth}
					{openLinksNewTab}
					{autoLoadFullText}
					{telemetryEnabled}
					showFeedback={isRecommended}
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
					{showImages}
					{showExcerpts}
					showReadMinutes={showMinutes}
					density={readerDensity}
					showFeedback={isRecommended}
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
