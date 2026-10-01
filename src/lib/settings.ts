// Shared settings keys, defaults and validation (no DB/Svelte imports —
// unit-testable and safe to import from both server helpers and components).

export const SETTING_KEYS = [
	'theme',
	'readerFontSize',
	'readerWidth',
	'density',
	'defaultView',
	'defaultSort',
	'focusModeDefault',
	'panelDefaultOpen',
	'markReadOnOpen',
	'showImagesInList',
	'showExcerpts',
	'showReadMinutes',
	'showUnreadBadges',
	'showFeedIcons',
	'collapseCollectionsDefault',
	'openLinksNewTab',
	'confirmBeforeRemove',
	'autoLoadFullText',
	'telemetryEnabled'
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export type ThemeValue = 'system' | 'light' | 'dark';
export type ReaderFontSize = 'compact' | 'comfortable' | 'large';
export type ReaderWidth = 'narrow' | 'wide';
export type DensityValue = 'comfortable' | 'compact';
export type DefaultView = 'list' | 'grid' | 'compact' | 'magazine';
export type DefaultSort = 'newest' | 'oldest' | 'title';

export type SettingValue =
	ThemeValue | ReaderFontSize | ReaderWidth | DensityValue | DefaultView | DefaultSort | boolean;

export type ResolvedSettings = Record<SettingKey, SettingValue>;

export const DEFAULT_SETTINGS: ResolvedSettings = {
	theme: 'system',
	readerFontSize: 'comfortable',
	readerWidth: 'narrow',
	density: 'comfortable',
	defaultView: 'list',
	defaultSort: 'newest',
	focusModeDefault: true,
	panelDefaultOpen: true,
	markReadOnOpen: true,
	showImagesInList: true,
	showExcerpts: true,
	showReadMinutes: true,
	showUnreadBadges: true,
	showFeedIcons: true,
	collapseCollectionsDefault: false,
	openLinksNewTab: true,
	confirmBeforeRemove: true,
	autoLoadFullText: false,
	telemetryEnabled: true
};

const ENUMS: Record<string, readonly string[]> = {
	theme: ['system', 'light', 'dark'],
	readerFontSize: ['compact', 'comfortable', 'large'],
	readerWidth: ['narrow', 'wide'],
	density: ['comfortable', 'compact'],
	defaultView: ['list', 'grid', 'compact', 'magazine'],
	defaultSort: ['newest', 'oldest', 'title']
};

const BOOLEANS: SettingKey[] = [
	'focusModeDefault',
	'panelDefaultOpen',
	'markReadOnOpen',
	'showImagesInList',
	'showExcerpts',
	'showReadMinutes',
	'showUnreadBadges',
	'showFeedIcons',
	'collapseCollectionsDefault',
	'openLinksNewTab',
	'confirmBeforeRemove',
	'autoLoadFullText',
	'telemetryEnabled'
];

export function isSettingKey(key: unknown): key is SettingKey {
	return typeof key === 'string' && (SETTING_KEYS as readonly string[]).includes(key);
}

/** Validate + coerce an untrusted value for a key. Returns null when invalid. */
export function sanitizeSetting(key: SettingKey, raw: unknown): SettingValue | null {
	const allowed = ENUMS[key];
	if (allowed) {
		return typeof raw === 'string' && allowed.includes(raw) ? (raw as SettingValue) : null;
	}
	if (BOOLEANS.includes(key)) {
		if (typeof raw === 'boolean') return raw;
		if (raw === 'true' || raw === '1' || raw === 1) return true;
		if (raw === 'false' || raw === '0' || raw === 0) return false;
		return null;
	}
	return null;
}

/** Merge DB rows over defaults; unknown keys and invalid values are dropped. */
export function resolveSettings(rows: Record<string, unknown>): ResolvedSettings {
	const out: ResolvedSettings = { ...DEFAULT_SETTINGS };
	for (const [k, v] of Object.entries(rows)) {
		if (!isSettingKey(k)) continue;
		const clean = sanitizeSetting(k, v);
		if (clean !== null) out[k] = clean;
	}
	return out;
}
