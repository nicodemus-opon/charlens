<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { setMode } from 'mode-watcher';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import SettingRow from '$lib/components/setting-row.svelte';
	import SettingOptions from '$lib/components/setting-options.svelte';
	import { resolveSettings, type SettingKey } from '$lib/settings.js';
	import { settingsStore } from '$lib/settings.svelte.js';

	let { data } = $props();

	const resolved = resolveSettings(data.settings ?? {});
	const feedback = $derived(data.feedback ?? []);

	let theme = $state<string>(String(resolved.theme));
	let readerFontSize = $state<string>(String(resolved.readerFontSize));
	let readerWidth = $state<string>(String(resolved.readerWidth));
	let density = $state<string>(String(resolved.density));
	let defaultView = $state<string>(String(resolved.defaultView));
	let defaultSort = $state<string>(String(resolved.defaultSort));
	let focusModeDefault = $state<boolean>(Boolean(resolved.focusModeDefault));
	let panelDefaultOpen = $state<boolean>(Boolean(resolved.panelDefaultOpen));
	let markReadOnOpen = $state<boolean>(Boolean(resolved.markReadOnOpen));
	let showImagesInList = $state<boolean>(Boolean(resolved.showImagesInList));
	let showExcerpts = $state<boolean>(Boolean(resolved.showExcerpts));
	let showReadMinutes = $state<boolean>(Boolean(resolved.showReadMinutes));
	let showUnreadBadges = $state<boolean>(Boolean(resolved.showUnreadBadges));
	let showFeedIcons = $state<boolean>(Boolean(resolved.showFeedIcons));
	let collapseCollectionsDefault = $state<boolean>(Boolean(resolved.collapseCollectionsDefault));
	let openLinksNewTab = $state<boolean>(Boolean(resolved.openLinksNewTab));
	let confirmBeforeRemove = $state<boolean>(Boolean(resolved.confirmBeforeRemove));
	let autoLoadFullText = $state<boolean>(Boolean(resolved.autoLoadFullText));
	let telemetryEnabled = $state<boolean>(Boolean(resolved.telemetryEnabled));

	let savedFlash = $state<string | null>(null);
	let busyReset = $state(false);
	let section = $state('appearance');

	function flash(msg: string) {
		savedFlash = msg;
		setTimeout(() => (savedFlash = null), 2500);
	}

	// Saves fire only from direct user interaction (toggle flips, option
	// taps) — never from reactive effects, so there is no save loop and no
	// re-save of the server payload on first paint.
	function save(key: SettingKey, value: string | boolean) {
		settingsStore.set(key, value as never);
		flash('Saved');
	}

	function saveTheme(next: string) {
		theme = next;
		if (next === 'light' || next === 'dark' || next === 'system') setMode(next);
		save('theme', next);
	}

	onMount(() => {
		settingsStore.init(data.settings ?? {}, data.user?.id ?? 'anonymous');
	});

	const sections = [
		{ id: 'appearance', label: 'Appearance' },
		{ id: 'reading', label: 'Reading & lists' },
		{ id: 'sidebar', label: 'Sidebar' },
		{ id: 'feeds', label: 'Feeds & links' },
		{ id: 'privacy', label: 'Recommended & privacy' },
		{ id: 'data', label: 'Data' }
	];

	function feedbackLabel(f: (typeof feedback)[number]): string {
		if (f.kind === 'mute_feed') return `Muted feed: ${f.feedTitle ?? `Feed ${f.feedId}`}`;
		if (f.kind === 'mute_topic') return `Muted topic: ${f.topic}`;
		if (f.kind === 'dismiss') return `Dismissed story ${f.articleId}`;
		return f.kind;
	}
</script>

<svelte:head>
	<title>Settings · charlens</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
	<div class="flex flex-col gap-1">
		<h1 tabindex="-1" data-settings-heading class="text-xl font-bold text-foreground">Settings</h1>
		<p class="text-sm text-muted-foreground">
			Applies to your account on every device. Changes save automatically.
		</p>
		{#if savedFlash}
			<p role="status" class="text-xs text-muted-foreground">{savedFlash}</p>
		{/if}
	</div>

	<nav aria-label="Settings sections" class="flex flex-wrap gap-2">
		{#each sections as s (s.id)}
			<Button
				variant={section === s.id ? 'secondary' : 'ghost'}
				size="sm"
				onclick={() => (section = s.id)}
				aria-current={section === s.id ? 'true' : undefined}
			>
				{s.label}
			</Button>
		{/each}
	</nav>

	{#if section === 'appearance'}
		<Card.Root>
			<Card.Header>
				<Card.Title>Appearance</Card.Title>
				<Card.Description
					>Theme and reader comfort. Theme also follows the menu toggle.</Card.Description
				>
			</Card.Header>
			<Card.Content>
				<SettingOptions
					title="Theme"
					description="System follows your OS. Stored on your account, applied instantly."
					bind:value={theme}
					options={[
						{ value: 'system', label: 'System' },
						{ value: 'light', label: 'Light' },
						{ value: 'dark', label: 'Dark' }
					]}
					onChange={saveTheme}
				/>
				<Separator />
				<SettingOptions
					title="Reader text size"
					description="Compact for skimming, large for long reads."
					bind:value={readerFontSize}
					options={[
						{ value: 'compact', label: 'Compact' },
						{ value: 'comfortable', label: 'Comfortable' },
						{ value: 'large', label: 'Large' }
					]}
					onChange={(v) => save('readerFontSize', v)}
				/>
				<Separator />
				<SettingOptions
					title="Reader width"
					description="Narrow is book-like, wide uses big screens."
					bind:value={readerWidth}
					options={[
						{ value: 'narrow', label: 'Narrow' },
						{ value: 'wide', label: 'Wide' }
					]}
					onChange={(v) => save('readerWidth', v)}
				/>
				<Separator />
				<SettingOptions
					title="List density"
					description="Compact fits more stories per screen."
					bind:value={density}
					options={[
						{ value: 'comfortable', label: 'Comfortable' },
						{ value: 'compact', label: 'Compact' }
					]}
					onChange={(v) => save('density', v)}
				/>
			</Card.Content>
		</Card.Root>
	{:else if section === 'reading'}
		<Card.Root>
			<Card.Header>
				<Card.Title>Reading & lists</Card.Title>
				<Card.Description
					>Defaults for every feed scope. Per-scope layouts you already set are kept.</Card.Description
				>
			</Card.Header>
			<Card.Content>
				<SettingOptions
					title="Default layout"
					description="Used when a feed or collection has no saved layout yet."
					bind:value={defaultView}
					options={[
						{ value: 'list', label: 'List' },
						{ value: 'compact', label: 'Compact' },
						{ value: 'grid', label: 'Cards' },
						{ value: 'magazine', label: 'Magazine' }
					]}
					onChange={(v) => save('defaultView', v)}
				/>
				<Separator />
				<SettingOptions
					title="Default sort"
					description="Newest first is the inbox order."
					bind:value={defaultSort}
					options={[
						{ value: 'newest', label: 'Newest first' },
						{ value: 'oldest', label: 'Oldest first' },
						{ value: 'title', label: 'Title A–Z' }
					]}
					onChange={(v) => save('defaultSort', v)}
				/>
				<Separator />
				<SettingRow
					title="Focus mode by default"
					description="Hide the list while reading when you open a story."
					bind:checked={focusModeDefault}
					onChange={(v) => save('focusModeDefault', v)}
				/>
				<Separator />
				<SettingRow
					title="List pane open by default"
					description="Desktop shows list + reader side by side."
					bind:checked={panelDefaultOpen}
					onChange={(v) => save('panelDefaultOpen', v)}
				/>
				<Separator />
				<SettingRow
					title="Mark as read on open"
					description="Opening a story marks it read. Turn off to triage manually."
					bind:checked={markReadOnOpen}
					onChange={(v) => save('markReadOnOpen', v)}
				/>
				<Separator />
				<SettingRow
					title="Images in lists"
					description="Thumbnails in list and card layouts."
					bind:checked={showImagesInList}
					onChange={(v) => save('showImagesInList', v)}
				/>
				<Separator />
				<SettingRow
					title="Excerpts in lists"
					description="Two-line previews under each title."
					bind:checked={showExcerpts}
					onChange={(v) => save('showExcerpts', v)}
				/>
				<Separator />
				<SettingRow
					title="Reading time"
					description="Show estimated minutes in lists and reader."
					bind:checked={showReadMinutes}
					onChange={(v) => save('showReadMinutes', v)}
				/>
			</Card.Content>
		</Card.Root>
	{:else if section === 'sidebar'}
		<Card.Root>
			<Card.Header>
				<Card.Title>Sidebar</Card.Title>
				<Card.Description>What the library shows. Collapse state stays per-device.</Card.Description
				>
			</Card.Header>
			<Card.Content>
				<SettingRow
					title="Unread badges"
					description="Counts on feeds, smart views and Today."
					bind:checked={showUnreadBadges}
					onChange={(v) => save('showUnreadBadges', v)}
				/>
				<Separator />
				<SettingRow
					title="Feed icons"
					description="Favicons next to feed names. Letters when off."
					bind:checked={showFeedIcons}
					onChange={(v) => save('showFeedIcons', v)}
				/>
				<Separator />
				<SettingRow
					title="Collections collapsed by default"
					description="Start with feed groups folded on new devices."
					bind:checked={collapseCollectionsDefault}
					onChange={(v) => save('collapseCollectionsDefault', v)}
				/>
			</Card.Content>
		</Card.Root>
	{:else if section === 'feeds'}
		<Card.Root>
			<Card.Header>
				<Card.Title>Feeds & links</Card.Title>
				<Card.Description
					>Safety and link behavior. Server refresh cadence is instance-wide.</Card.Description
				>
			</Card.Header>
			<Card.Content>
				<SettingRow
					title="Open links in a new tab"
					description="Originals and external sites never replace your reader."
					bind:checked={openLinksNewTab}
					onChange={(v) => save('openLinksNewTab', v)}
				/>
				<Separator />
				<SettingRow
					title="Confirm before removing"
					description="Ask before removing a feed or deleting a collection."
					bind:checked={confirmBeforeRemove}
					onChange={(v) => save('confirmBeforeRemove', v)}
				/>
				<Separator />
				<SettingRow
					title="Auto-load full text"
					description="Fetch the full article when a feed only ships an excerpt."
					bind:checked={autoLoadFullText}
					onChange={(v) => save('autoLoadFullText', v)}
				/>
				<p class="py-2 text-xs text-muted-foreground">
					Automatic refresh runs every 15 minutes on the server. Per-feed cadence is not per-user.
				</p>
			</Card.Content>
		</Card.Root>
	{:else if section === 'privacy'}
		<Card.Root>
			<Card.Header>
				<Card.Title>Recommended & privacy</Card.Title>
				<Card.Description>What powers picks for you, and how to undo it.</Card.Description>
			</Card.Header>
			<Card.Content>
				<SettingRow
					title="Reading signals"
					description="Count opens, dwell and scroll to rank Recommended. Off means chronological only."
					bind:checked={telemetryEnabled}
					onChange={(v) => save('telemetryEnabled', v)}
				/>
				<Separator />
				<div class="flex flex-col gap-2 py-4">
					<p class="text-sm font-medium text-foreground">Muted & dismissed ({feedback.length})</p>
					{#if feedback.length === 0}
						<p class="text-xs text-muted-foreground">Nothing muted yet.</p>
					{:else}
						<ul class="flex flex-col gap-2">
							{#each feedback as f (f.id)}
								<li class="flex items-center gap-2">
									<Badge variant="secondary" class="min-w-0 flex-1 justify-start">
										<span class="min-w-0 truncate">{feedbackLabel(f)}</span>
									</Badge>
									<form method="POST" action="?/removeFeedback" use:enhance>
										<input type="hidden" name="id" value={f.id} />
										<Button variant="ghost" size="sm" type="submit">Undo</Button>
									</form>
								</li>
							{/each}
						</ul>
					{/if}
					<form
						method="POST"
						action="?/resetRecommended"
						use:enhance={() => {
							return async ({ update }) => await update();
						}}
					>
						<Button variant="outline" size="sm" type="submit">Reset recommendations</Button>
					</form>
				</div>
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title>Data</Card.Title>
				<Card.Description>Start over without losing feeds.</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="flex flex-col gap-3 py-2">
					<form
						method="POST"
						action="?/resetScopes"
						use:enhance={() => {
							busyReset = true;
							return async ({ update }) => {
								await update();
								busyReset = false;
								flash('Layouts cleared');
							};
						}}
					>
						<Button variant="outline" size="sm" type="submit" disabled={busyReset}>
							Reset layouts & settings
						</Button>
						<p class="mt-1 text-xs text-muted-foreground">
							Clears per-feed layouts and all settings on this page. Feeds and tags stay.
						</p>
					</form>
					<form
						method="POST"
						action="?/resetSettings"
						use:enhance={() => {
							return async ({ update }) => {
								await update();
								await settingsStore.resetAll();
								flash('Settings restored to defaults');
							};
						}}
					>
						<Button variant="ghost" size="sm" type="submit">Restore defaults</Button>
					</form>
				</div>
			</Card.Content>
		</Card.Root>
	{/if}
</div>
