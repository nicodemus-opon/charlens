// Tiny in-memory fixed-window rate limiter (single process is fine for a
// self-hosted app — no Redis). Keys are `scope:tokenPrefix|ip`.

interface Bucket {
	count: number;
	resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function checkRateLimit(
	key: string,
	limit: number,
	windowMs: number,
	now = Date.now()
): { allowed: boolean; retryAfterSec: number } {
	const cur = buckets.get(key);
	if (!cur || now >= cur.resetAt) {
		buckets.set(key, { count: 1, resetAt: now + windowMs });
		return { allowed: true, retryAfterSec: 0 };
	}
	if (cur.count < limit) {
		cur.count += 1;
		return { allowed: true, retryAfterSec: 0 };
	}
	return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)) };
}

/** Test-only: clear all buckets. */
export function _resetRateLimitsForTests(): void {
	buckets.clear();
}

/** Read client IP for fallback bucketing when no token is present. */
export function clientIp(request: Request): string {
	return (
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
		request.headers.get('x-real-ip')?.trim() ||
		'unknown'
	);
}
