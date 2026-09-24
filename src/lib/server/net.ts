import http from 'node:http';
import type { RequestOptions as HttpsRequestOptions } from 'node:https';
import https from 'node:https';

/**
 * Network hardening for outbound fetches.
 *
 * Node ≥20 enables Happy Eyeballs (`autoSelectFamily: true`) by default. On
 * networks with broken IPv6 (no route, DNS returns AAAA anyway) the racing
 * logic can stall and fail the IPv4 attempt too — observed as `ETIMEDOUT`
 * against hosts like news.ycombinator.com / lobste.rs while curl, python and
 * openssl connect fine (raw TCP + TLS-to-IP succeed; only the
 * hostname-based connection with family autoselection hangs). rss-parser and
 * undici-based `fetch` both go through this path, so a feed add "succeeds"
 * (placeholder row kept as transient) but lands 0 articles.
 *
 * Disabling family autoselection makes Node use DNS order (IPv4 first where
 * the resolver returns it first) and fixes these hosts. This is also set
 * process-wide via `NODE_OPTIONS=--no-network-family-autoselection` in the
 * Dockerfile/compose; the per-request options below are belt-and-suspenders
 * so dev (`pnpm dev`) and any environment without the flag still work.
 */

/** Request options forcing DNS-order (usually IPv4-first) connections. */
export const IPV4_COMPAT_REQUEST_OPTIONS = {
	autoSelectFamily: false
	// Runtime socket option (Node ≥18.13) that @types/node doesn't thread into
	// http.get's typings — the cast bridges that types gap (verified live:
	// rss-parser forwards requestOptions straight to http/https.get).
} as unknown as HttpsRequestOptions & { autoSelectFamily: boolean };

const MAX_REDIRECTS = 5;

export interface FetchExternalResult {
	status: number;
	contentType: string;
	body: Buffer;
	finalUrl: string;
}

/**
 * GET an external URL with redirects, timeout and family-autoselection off.
 * Minimal fetch replacement for server-side HTML/JSON fetches where the
 * global `fetch` (undici) cannot take per-request socket options without an
 * extra dependency.
 */
export function fetchExternal(
	rawUrl: string,
	opts: { timeoutMs?: number; headers?: Record<string, string> } = {}
): Promise<FetchExternalResult> {
	const timeoutMs = opts.timeoutMs ?? 15_000;
	return new Promise((resolve, reject) => {
		const go = (target: string, redirectsLeft: number): void => {
			let u: URL;
			try {
				u = new URL(target);
			} catch {
				reject(new Error('Invalid article URL'));
				return;
			}
			if (u.protocol !== 'http:' && u.protocol !== 'https:') {
				reject(new Error('Unsupported protocol'));
				return;
			}
			const lib = u.protocol === 'https:' ? https : http;
			const req = lib.get(
				{
					protocol: u.protocol,
					hostname: u.hostname,
					port: u.port || undefined,
					path: `${u.pathname}${u.search}`,
					headers: opts.headers,
					...IPV4_COMPAT_REQUEST_OPTIONS
				},
				(res) => {
					const status = res.statusCode ?? 0;
					const location = res.headers.location;
					if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
						res.resume();
						try {
							go(new URL(location, u).toString(), redirectsLeft - 1);
						} catch {
							reject(new Error('Invalid redirect'));
						}
						return;
					}
					if (status >= 300 && status < 400 && location) {
						res.resume();
						reject(new Error('Too many redirects'));
						return;
					}
					const chunks: Buffer[] = [];
					res.on('data', (c: Buffer) => chunks.push(c));
					res.on('end', () => {
						clearTimeout(timer);
						resolve({
							status,
							contentType: res.headers['content-type'] ?? '',
							body: Buffer.concat(chunks),
							finalUrl: target
						});
					});
					res.on('error', (e) => {
						clearTimeout(timer);
						reject(e);
					});
				}
			);
			const timer = setTimeout(() => {
				req.destroy(new Error(`fetch timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			req.on('error', (e) => {
				clearTimeout(timer);
				reject(e);
			});
		};
		go(rawUrl, MAX_REDIRECTS);
	});
}
