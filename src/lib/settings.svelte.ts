import { browser } from '$app/environment';
import {
	DEFAULT_SETTINGS,
	isSettingKey,
	resolveSettings,
	sanitizeSetting,
	type ResolvedSettings,
	type SettingKey,
	type SettingValue
} from '$lib/settings.js';

const CACHE_BASE = 'charlens:settings';

function cacheKey(userId: string): string {
	return `${CACHE_BASE}:${userId}`;
}

function readCache(userId: string): Record<string, unknown> {
	if (!browser) return {};
	try {
		const raw = localStorage.getItem(cacheKey(userId));
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Corrupt cache — ignore.
	}
	return {};
}

function writeCache(userId: string, settings: ResolvedSettings): void {
	if (!browser) return;
	try {
		localStorage.setItem(cacheKey(userId), JSON.stringify(settings));
	} catch {
		// Storage unavailable — skip.
	}
}

/** One-time adoption of pre-settings legacy keys into the new store. */
function readLegacyInto(userId: string, out: Record<string, unknown>): boolean {
	if (!browser) return false;
	let adopted = false;
	try {
		const panel = localStorage.getItem(`charlens:article-panel-open:${userId}`);
		if (panel === 'open' || panel === 'closed') {
			out.panelDefaultOpen = panel === 'open';
			adopted = true;
		}
		const focus = localStorage.getItem(`charlens:focus-mode:${userId}`);
		if (focus === 'on' || focus === 'off') {
			out.focusModeDefault = focus === 'on';
			adopted = true;
		}
		const legacyView = localStorage.getItem(`charlens:article-view:${userId}`);
		if (
			legacyView === 'list' ||
			legacyView === 'grid' ||
			legacyView === 'compact' ||
			legacyView === 'magazine'
		) {
			out.defaultView = legacyView;
			adopted = true;
		}
		const mode = localStorage.getItem('mode-watcher-mode');
		if (mode === 'light' || mode === 'dark' || mode === 'system') {
			out.theme = mode;
			adopted = true;
		}
	} catch {
		return false;
	}
	return adopted;
}

class SettingsStore {
	values = $state<ResolvedSettings>({ ...DEFAULT_SETTINGS });
	userId = $state('');
	ready = $state(false);
	private timers = new Map<SettingKey, ReturnType<typeof setTimeout>>();

	init(serverSettings: Record<string, unknown> | undefined, userId: string): void {
		this.userId = userId;
		const cached = readCache(userId);
		// Server wins over cache; cache fills gaps only. Legacy keys seed
		// missing values once, then persist to the server below.
		const legacy: Record<string, unknown> = {};
		const hadLegacy = readLegacyInto(userId, legacy);
		const merged = resolveSettings({ ...legacy, ...cached, ...(serverSettings ?? {}) });
		// Server rows always override cache/legacy for keys the server knows.
		const serverResolved = resolveSettings(serverSettings ?? {});
		const serverKeys = Object.keys(serverSettings ?? {});
		for (const k of serverKeys) {
			if (isSettingKey(k)) merged[k] = serverResolved[k];
		}
		this.values = merged;
		this.ready = true;
		writeCache(userId, merged);
		if (hadLegacy && browser) {
			// Push adopted legacy values to the server (fire-and-forget).
			for (const [k, v] of Object.entries(legacy)) {
				if (isSettingKey(k) && sanitizeSetting(k, v) !== null)
					void this.persist(k, v as SettingValue);
			}
		}
	}

	get<K extends SettingKey>(key: K): ResolvedSettings[K] {
		return this.values[key];
	}

	set<K extends SettingKey>(key: K, value: ResolvedSettings[K]): void {
		const clean = sanitizeSetting(key, value);
		if (clean === null) return;
		this.values[key] = clean as ResolvedSettings[K];
		writeCache(this.userId, this.values);
		const existing = this.timers.get(key);
		if (existing) clearTimeout(existing);
		this.timers.set(
			key,
			setTimeout(() => {
				void this.persist(key, clean);
			}, 300)
		);
	}

	private async persist(key: SettingKey, value: SettingValue): Promise<void> {
		try {
			const form = new FormData();
			form.set('key', key);
			form.set('value', JSON.stringify(value));
			await fetch('/settings?/saveSetting', { method: 'POST', body: form });
		} catch (e) {
			console.error('settings save failed', e);
		}
	}

	async resetAll(): Promise<void> {
		try {
			await fetch('/settings?/resetSettings', { method: 'POST' });
		} catch (e) {
			console.error('settings reset failed', e);
		}
		this.values = { ...DEFAULT_SETTINGS };
		writeCache(this.userId, this.values);
	}
}

export const settingsStore = new SettingsStore();
