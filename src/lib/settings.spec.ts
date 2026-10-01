import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, isSettingKey, resolveSettings, sanitizeSetting } from './settings';

describe('settings', () => {
	it('accepts valid enum values and rejects others', () => {
		expect(sanitizeSetting('theme', 'dark')).toBe('dark');
		expect(sanitizeSetting('theme', 'neon')).toBeNull();
		expect(sanitizeSetting('defaultView', 'magazine')).toBe('magazine');
		expect(sanitizeSetting('defaultSort', 'title')).toBe('title');
		expect(sanitizeSetting('readerFontSize', 'huge')).toBeNull();
	});

	it('coerces booleans from strings', () => {
		expect(sanitizeSetting('telemetryEnabled', true)).toBe(true);
		expect(sanitizeSetting('telemetryEnabled', 'false')).toBe(false);
		expect(sanitizeSetting('telemetryEnabled', 'yes')).toBeNull();
	});

	it('resolves DB rows over defaults and drops unknown keys', () => {
		const out = resolveSettings({ theme: 'dark', bogus: 'x', defaultSort: 'nope' });
		expect(out.theme).toBe('dark');
		expect(out.defaultSort).toBe(DEFAULT_SETTINGS.defaultSort);
		expect('bogus' in out).toBe(false);
	});

	it('guards key names', () => {
		expect(isSettingKey('theme')).toBe(true);
		expect(isSettingKey('__proto__')).toBe(false);
	});
});
