import type { RequestHandler } from './$types';
import { guardApi, handleOptions, send } from '$lib/server/api/guard';
import { apiError, ok } from '$lib/server/api/respond';
import { getUserSettings, setUserSetting } from '$lib/server/settings';
import { isSettingKey, sanitizeSetting } from '$lib/settings.js';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

export const GET: RequestHandler = async ({ request, locals }) => {
	const g = await guardApi(request, locals, { scope: 'read', bucket: 'settings' });
	if ('response' in g) return g.response;
	return send(request, ok({ settings: await getUserSettings(g.user.id) }));
};

export const PATCH: RequestHandler = async ({ request, locals }) => {
	const g = await guardApi(request, locals, { scope: 'write', bucket: 'settings' });
	if ('response' in g) return g.response;
	let body: { settings?: unknown };
	try {
		body = await request.json();
	} catch {
		return send(request, apiError('invalid_body', 'Body must be JSON', 422));
	}
	if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings))
		return send(request, apiError('invalid_body', 'settings must be an object', 422));
	const updated: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(body.settings as Record<string, unknown>)) {
		if (!isSettingKey(key))
			return send(request, apiError('invalid_body', `Unknown setting: ${key}`, 422));
		const clean = sanitizeSetting(key, value);
		if (clean === null)
			return send(request, apiError('invalid_body', `Invalid value for: ${key}`, 422));
		const saved = await setUserSetting(g.user.id, key, clean);
		if (!saved) return send(request, apiError('save_failed', `Could not save: ${key}`, 500));
		updated[key] = clean;
	}
	return send(request, ok({ settings: await getUserSettings(g.user.id), updated }));
};
