import { env } from '$env/dynamic/private';

export interface RadarCandidate {
	routePath: string;
	/** Directly subscribable feed URL. Empty when the route needs params. */
	url: string;
	title: string;
	needsParams: boolean;
	/** Link to the route's docs page (for parameterized routes). */
	docs?: string;
	/**
	 * Param values extracted from the pasted site URL via the rule's `source`
	 * patterns (e.g. `/@ColeooyChess` → `{ username: '@ColeooyChess' }`).
	 * Shown pre-filled and editable — never applied blindly.
	 */
	prefill?: Record<string, string>;
}

const RADAR_CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_CANDIDATES = 5;

let radarCache: { at: number; payload: unknown } | null = null;

export function getRsshubBase(): string {
	const raw = (env.RSSHUB_BASE_URL ?? 'http://localhost:1200').trim() || 'http://localhost:1200';
	return raw.replace(/\/+$/, '');
}

export function isRsshubEnabled(): boolean {
	return (env.RSSHUB_ENABLED ?? '1') !== '0';
}

function timeoutMs(): number {
	const n = Number(env.RSSHUB_TIMEOUT_MS ?? 15000);
	return Number.isFinite(n) && n > 0 ? Math.min(n, 60000) : 15000;
}

/** True when the URL points at the configured RSSHub instance. */
export function isRsshubUrl(url: string): boolean {
	try {
		const base = new URL(getRsshubBase());
		const u = new URL(url);
		return u.host.toLowerCase() === base.host.toLowerCase();
	} catch {
		return false;
	}
}

const ALLOWED_PARAMS = new Set([
	'filter',
	'filter_title',
	'filter_description',
	'filter_author',
	'filter_category',
	'filter_time',
	'filter_case_sensitive',
	'filterout',
	'filterout_title',
	'filterout_description',
	'filterout_author',
	'filterout_category',
	'limit',
	'sorted',
	'mode',
	'format',
	'brief',
	'opencc'
]);

export interface RsshubParams {
	limit?: number;
	mode?: 'fulltext' | string;
	format?: 'rss' | 'atom' | 'json';
	sorted?: boolean;
	filter?: string;
	[key: string]: string | number | boolean | undefined;
}

/** Build a safe RSSHub feed URL. Always pins `format=rss` for rss-parser. */
export function buildRsshubUrl(routePath: string, params: RsshubParams = {}): string {
	let path = routePath.trim();
	if (!path.startsWith('/')) path = `/${path}`;
	if (path.includes('..') || path.includes('//') || path.includes(' ') || path.includes('\\')) {
		throw new Error('Invalid RSSHub route path');
	}
	if (path.length > 500) throw new Error('RSSHub route path too long');
	const base = getRsshubBase();
	const url = new URL(`${base}${path}`);
	const merged: Record<string, string> = {
		format: 'rss',
		mode: 'fulltext',
		limit: '50',
		sorted: 'true'
	};
	for (const [k, v] of Object.entries(params)) {
		if (!ALLOWED_PARAMS.has(k) || v === undefined) continue;
		const s = String(v).slice(0, 300);
		if (/[<>"'`]/.test(s)) continue;
		merged[k] = s;
	}
	for (const [k, v] of Object.entries(merged)) url.searchParams.set(k, v);
	return url.toString();
}

/**
 * Strict-match one Radar `source` pattern against a site path.
 * Returns captured `:param` values, or null when it doesn't match.
 * e.g. pattern `/:username` vs path `/@ColeooyChess` → `{ username: '@ColeooyChess' }`.
 */
export function matchSourcePattern(pattern: string, path: string): Record<string, string> | null {
	const segments = pattern.split('/').filter((s) => s !== '');
	const parts: string[] = [];
	const names: { name: string; optional: boolean }[] = [];
	for (const seg of segments) {
		const m = seg.match(/^:([A-Za-z0-9_]+)(\{[^}]*\})?(\?)?$/);
		if (m) {
			const optional = m[3] === '?';
			names.push({ name: m[1], optional });
			// Optional params make their whole segment skippable.
			parts.push(optional ? `(?:/(${m[2] ? '.+' : '[^/]+'}))?` : `/(${m[2] ? '.+' : '[^/]+'})`);
		} else {
			parts.push('/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
		}
	}
	let re: RegExp;
	try {
		re = new RegExp(`^${parts.join('')}/?$`);
	} catch {
		return null;
	}
	const hit = path.match(re);
	if (!hit) return null;
	const out: Record<string, string> = {};
	names.forEach((n, i) => {
		const v = hit[i + 1];
		if (v !== undefined) out[n.name] = decodeURIComponent(v);
	});
	return out;
}

/** Param names of a target template, in order of appearance. */
export function targetParams(target: string): string[] {
	const names: string[] = [];
	const re = /:([A-Za-z0-9_]+)(?:\{[^}]*\})?(\?)?/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(target)) !== null) {
		if (!names.includes(m[1])) names.push(m[1]);
	}
	return names;
}

/** Required (non-`?`) param names of a target template. */
export function requiredTargetParams(target: string): string[] {
	const names: string[] = [];
	const re = /:([A-Za-z0-9_]+)(?:\{[^}]*\})?(\?)?/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(target)) !== null) {
		if (m[2] !== '?' && !names.includes(m[1])) names.push(m[1]);
	}
	return names;
}

/**
 * Resolve a candidate to a subscribable feed URL, filling its template from
 * prefill. Returns null when required params are still missing (caller should
 * ask the user instead of guessing).
 */
export function resolveCandidateUrl(
	c: Pick<RadarCandidate, 'routePath' | 'url' | 'prefill'>
): string | null {
	if (!/:(\w+)/.test(c.routePath)) return c.url || null;
	const missing = requiredTargetParams(c.routePath).filter(
		(n) => (c.prefill?.[n] ?? '').trim() === ''
	);
	if (missing.length > 0) return null;
	const filled = c.routePath.replace(/:([A-Za-z0-9_]+)(?:\{[^}]*\})?(\?)?/g, (_, name: string) =>
		(c.prefill?.[name] ?? '').trim()
	);
	const path = filled.replace(/\/{2,}/g, '/');
	return `${getRsshubBase()}${path}?format=rss&mode=fulltext`;
}

/**
 * Generic extraction: find the rule `source` pattern matching the pasted path
 * and map its values onto the `target` route params — by name when they agree
 * (`:id` → `:id`, the common case), by position otherwise.
 * Returns partial values when only some params resolve; null when no source
 * pattern matches strictly.
 */
export function extractPrefill(
	source: unknown,
	target: string,
	path: string
): Record<string, string> | null {
	const patterns = (Array.isArray(source) ? source : [source]).filter(
		(s): s is string => typeof s === 'string' && s.startsWith('/')
	);
	const wanted = targetParams(target);
	if (wanted.length === 0) return null;
	for (const pattern of patterns) {
		const captures = matchSourcePattern(pattern, path);
		if (!captures) continue;
		const values: Record<string, string> = {};
		const captured = Object.entries(captures);
		wanted.forEach((name, i) => {
			if (captures[name] !== undefined) values[name] = captures[name];
			else if (captured[i] !== undefined) values[name] = captured[i][1];
		});
		if (Object.keys(values).length > 0) return values;
	}
	return null;
}

/**
 * Pure matcher over `/api/radar/rules` payloads. RSSHub rule shapes vary by
 * version, so walk defensively: collect any node with a string `target` and a
 * `source` string/array whose host or path prefix matches the site URL.
 * When a `source` pattern strictly matches the pasted path, its values are
 * attached as `prefill` for the target params.
 */
export function matchRadarRules(rules: unknown, siteUrl: string): RadarCandidate[] {
	let site: URL;
	try {
		const withProto = /^https?:\/\//i.test(siteUrl.trim())
			? siteUrl.trim()
			: `https://${siteUrl.trim()}`;
		site = new URL(withProto);
	} catch {
		return [];
	}
	const host = site.hostname.toLowerCase().replace(/^www\./, '');
	const path = site.pathname || '/';
	const base = getRsshubBase();
	const out: RadarCandidate[] = [];
	const seen = new Set<string>();

	function push(target: string, title: string, docs?: string, prefill?: Record<string, string>) {
		const t = target.trim();
		if (!t.startsWith('/')) return;
		// Templates with unfilled params are not subscribable as-is: keep them
		// as info rows (route path + docs link) with an empty url so callers
		// never offer them as one-click feeds. Prefill (values extracted from
		// the pasted URL) lets the UI present them already filled in.
		const needsParams = /:\w+/.test(t);
		const key = t;
		if (seen.has(key) || out.length >= MAX_CANDIDATES) return;
		seen.add(key);
		out.push({
			routePath: t,
			url: needsParams ? '' : `${base}${t}?format=rss&mode=fulltext`,
			title: title || t,
			needsParams,
			docs: typeof docs === 'string' && docs.startsWith('http') ? docs : undefined,
			prefill: prefill && Object.keys(prefill).length > 0 ? prefill : undefined
		});
	}

	function sourcesMatch(source: unknown): boolean {
		const list = Array.isArray(source) ? source : [source];
		for (const s of list) {
			if (typeof s !== 'string') continue;
			const norm = s.toLowerCase();
			// Site-path patterns ("/", "/:category", "/blog/:id") belong to the
			// already domain-matched namespace: bare or parameterized roots
			// match any page, deeper prefixes must match the site path.
			if (norm.startsWith('/')) {
				if (norm === '/') return true;
				const prefix = norm.split('/:')[0].split('/*')[0].split('?')[0];
				if (!prefix || prefix === '/') return true;
				if (path.startsWith(prefix)) return true;
				continue;
			}
			if (norm === '') return true;
			if (norm.includes(host) || host.includes(norm.replace(/[^a-z0-9.-]/g, ''))) return true;
		}
		return false;
	}

	function walk(node: unknown, namespace: string) {
		if (!node || out.length >= MAX_CANDIDATES) return;
		if (Array.isArray(node)) {
			for (const item of node) walk(item, namespace);
			return;
		}
		if (typeof node !== 'object') return;
		const rec = node as Record<string, unknown>;
		if (typeof rec['target'] === 'string' && rec['source'] !== undefined) {
			if (sourcesMatch(rec['source'])) {
				const title = typeof rec['title'] === 'string' && rec['title'] ? rec['title'] : namespace;
				const docs = typeof rec['docs'] === 'string' ? rec['docs'] : undefined;
				const prefill = extractPrefill(rec['source'], rec['target'] as string, path) ?? undefined;
				push(rec['target'] as string, title, docs, prefill);
			}
		}
		for (const [k, v] of Object.entries(rec)) {
			if (k === 'target' || k === 'source') continue;
			walk(v, k.startsWith('/') || namespace ? namespace : k);
		}
	}

	// Index by domain first when the payload is keyed by host.
	if (rules && typeof rules === 'object' && !Array.isArray(rules)) {
		const rec = rules as Record<string, unknown>;
		const container =
			rec['data'] && typeof rec['data'] === 'object'
				? (rec['data'] as Record<string, unknown>)
				: rec;
		for (const [domain, value] of Object.entries(container)) {
			const d = domain.toLowerCase().replace(/^www\./, '');
			if (d === host || host.endsWith(`.${d}`) || d.includes(host) || host.includes(d)) {
				walk(value, domain);
			}
		}
		// Fallback: full walk if domain indexing found nothing.
		if (out.length === 0) walk(container, '');
	} else {
		walk(rules, '');
	}
	// Directly subscribable routes first; parameterized templates last —
	// unless the pasted URL already supplied every param (prefill), in which
	// case they behave like direct routes.
	const isReady = (c: RadarCandidate) =>
		!c.needsParams ||
		requiredTargetParams(c.routePath).every((n) => (c.prefill?.[n] ?? '').trim() !== '');
	return out.sort((a, b) => Number(!isReady(a)) - Number(!isReady(b)));
}

async function fetchRadarRules(): Promise<unknown> {
	const now = Date.now();
	if (radarCache && now - radarCache.at < RADAR_CACHE_MS) return radarCache.payload;
	const base = getRsshubBase();
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs());
	try {
		const res = await fetch(`${base}/api/radar/rules`, {
			signal: ctrl.signal,
			headers: { 'User-Agent': 'charlens-rss/0.1 (+radar)' }
		});
		if (!res.ok) throw new Error(`radar rules ${res.status}`);
		const json = (await res.json()) as unknown;
		radarCache = { at: now, payload: json };
		return json;
	} finally {
		clearTimeout(t);
	}
}

/** Site URL → up to 5 RSSHub route suggestions. Never throws; `failed` distinguishes an instance/rules outage (retry later) from "no rule matched" (definitive). */
export async function getRadarCandidates(
	siteUrl: string
): Promise<{ candidates: RadarCandidate[]; failed: boolean }> {
	if (!isRsshubEnabled()) return { candidates: [], failed: false };
	try {
		const rules = await fetchRadarRules();
		return { candidates: matchRadarRules(rules, siteUrl), failed: false };
	} catch (e) {
		console.error('rsshub radar lookup failed', e);
		return { candidates: [], failed: true };
	}
}

export async function rsshubHealth(): Promise<{ ok: boolean; base: string }> {
	const base = getRsshubBase();
	if (!isRsshubEnabled()) return { ok: false, base };
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 5000);
		try {
			const res = await fetch(`${base}/healthz`, { signal: ctrl.signal });
			return { ok: res.ok, base };
		} finally {
			clearTimeout(t);
		}
	} catch {
		return { ok: false, base };
	}
}

/** Test-only: reset the in-memory radar cache. */
export function _resetRadarCache() {
	radarCache = null;
}
