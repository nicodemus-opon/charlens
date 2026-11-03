import { json } from '@sveltejs/kit';

/** Success envelope: `{ ok: true, …rest }`. */
export function ok(body: Record<string, unknown> = {}, status = 200): Response {
	return json({ ok: true, ...body }, { status });
}

/** Error envelope: `{ error: { code, message } }`. */
export function apiError(code: string, message: string, status: number): Response {
	return json({ error: { code, message } }, { status });
}

export const unauthorized = (message = 'Missing or invalid API token') =>
	apiError('unauthorized', message, 401);
export const forbidden = (message = 'Insufficient scope') => apiError('forbidden', message, 403);
export const notFound = (message = 'Not found') => apiError('not_found', message, 404);
export const unprocessable = (message: string) => apiError('unprocessable', message, 422);
export const rateLimited = (retryAfterSec: number) =>
	json(
		{ error: { code: 'rate_limited', message: 'Rate limit exceeded' } },
		{ status: 429, headers: { 'Retry-After': String(retryAfterSec) } }
	);
