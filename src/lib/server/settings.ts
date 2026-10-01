import { db } from '$lib/server/db';
import { userSetting } from '$lib/server/db/feeds.schema';
import { eq } from 'drizzle-orm';
import {
	DEFAULT_SETTINGS,
	resolveSettings,
	sanitizeSetting,
	type ResolvedSettings,
	type SettingKey,
	type SettingValue
} from '$lib/settings.js';

export { DEFAULT_SETTINGS };
export type { ResolvedSettings, SettingKey, SettingValue };

export async function getUserSettings(userId: string): Promise<ResolvedSettings> {
	const rows = await db
		.select({ key: userSetting.key, value: userSetting.value })
		.from(userSetting)
		.where(eq(userSetting.userId, userId));
	const raw: Record<string, unknown> = {};
	for (const row of rows) raw[row.key] = row.value;
	return resolveSettings(raw);
}

export async function setUserSetting(
	userId: string,
	key: SettingKey,
	value: SettingValue
): Promise<boolean> {
	const clean = sanitizeSetting(key, value);
	if (clean === null) return false;
	if (key.length > 64) return false;
	await db
		.insert(userSetting)
		.values({ userId, key, value: clean })
		.onConflictDoUpdate({
			target: [userSetting.userId, userSetting.key],
			set: { value: clean, updatedAt: new Date() }
		});
	return true;
}

export async function resetUserSettings(userId: string): Promise<void> {
	const { eq: eqOp } = await import('drizzle-orm');
	await db.delete(userSetting).where(eqOp(userSetting.userId, userId));
}
