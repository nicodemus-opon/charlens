import { env } from '$env/dynamic/private';
import { requireApiUser, requireScope, type ApiUser } from './auth';
import { clientIp, checkRateLimit } from './rate-limit';
import { forbidden, rateLimited, unauthorized } from './respond';
import type { ApiScope } from './validate';

interface GuardOpts {
	scope: ApiScope;
	/** Max requests per window per caller. */
	limit?: number;
	windowMs?: number;
	/** Bucket namespace so expensive routes get their own quota. */
	bucket?: string;
}

function corsOrigins(): string[] {
	return (env.API_CORS_ORIGINS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Attach CORS headers when the Origin is allowlisted. */
export function withCors(request: Request, res: Response): Response {
	const origin = request.headers.get('origin');
	if (!origin) return res;
	if (!corsOrigins().includes(origin)) return res;
	const headers = new Headers(res.headers);
	headers.set('Access-Control-Allow-Origin', origin);
	headers.set('Vary', 'Origin');
	headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
	headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
	return new Response(res.body, { status: res.status, headers });
}

/** Shared preflight reply for every v1 route. */
export function handleOptions(request: Request): Response {
	return withCors(
		request,
		new Response(null, {
			status: 204,
			headers: { 'Access-Control-Max-Age': '86400' }
		})
	);
}

function rateLimitFor(opts: GuardOpts): { limit: number; windowMs: number } {
	const defLimit = Number(env.API_RATE_LIMIT_PER_MIN ?? 60);
	const limit =
		opts.limit ?? (Number.isFinite(defLimit) && defLimit > 0 ? Math.floor(defLimit) : 60);
	return { limit, windowMs: opts.windowMs ?? 60_000 };
}

/**
 * Auth + scope + rate-limit gate for v1 handlers. Returns the user on success;
 * otherwise a ready-to-return Response (401/403/429, CORS-stamped).
 */
export async function guardApi(
	request: Request,
	locals: App.Locals,
	opts: GuardOpts
): Promise<{ user: ApiUser } | { response: Response }> {
	const user = await requireApiUser(request, locals);
	if (!user) return { response: withCors(request, unauthorized()) };
	if (!requireScope(user, opts.scope))
		return { response: withCors(request, forbidden('This token has read-only scope')) };
	const { limit, windowMs } = rateLimitFor(opts);
	const key = `${opts.bucket ?? 'api'}:${user.authMethod === 'token' ? user.tokenPrefix : `session:${user.id}`} :${clientIp(request)}`;
	const rl = checkRateLimit(key, limit, windowMs);
	if (!rl.allowed) return { response: withCors(request, rateLimited(rl.retryAfterSec)) };
	return { user };
}

export function send(request: Request, res: Response): Response {
	return withCors(request, res);
}
