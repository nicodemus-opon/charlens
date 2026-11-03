import type { RequestHandler } from './$types';
import { handleOptions, send } from '$lib/server/api/guard';
import { ok } from '$lib/server/api/respond';
import { rsshubHealth } from '$lib/server/rss/rsshub';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

/** Public liveness probe (no auth): `{ ok, version, rsshubOk }`. */
export const GET: RequestHandler = async ({ request }) => {
	let rsshubOk = false;
	try {
		rsshubOk = (await rsshubHealth()).ok;
	} catch {
		rsshubOk = false;
	}
	return send(request, ok({ version: 'v1', rsshubOk }));
};
