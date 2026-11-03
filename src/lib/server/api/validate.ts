// Pure request parsers for the public API (no DB/SvelteKit imports —
// unit-testable). DB-backed route handlers compose these with service calls.

export const API_DEFAULT_LIMIT = 30;
export const API_MAX_LIMIT = 100;

export type ApiScope = 'read' | 'write';

export function parseApiScopes(input: unknown): ApiScope[] | null {
	const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
	const clean = [...new Set(list.map((s) => String(s).trim().toLowerCase()))].filter(
		(s): s is ApiScope => s === 'read' || s === 'write'
	);
	if (clean.length === 0) return null;
	// write implies read
	if (clean.includes('write') && !clean.includes('read')) clean.unshift('read');
	return clean;
}

export function scopesToString(scopes: ApiScope[]): string {
	return [...scopes].sort().join(',');
}

export function scopesFromString(raw: string | null | undefined): ApiScope[] {
	return (raw ?? '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter((s): s is ApiScope => s === 'read' || s === 'write');
}

export function hasScope(scopes: ApiScope[], need: ApiScope): boolean {
	if (scopes.includes(need)) return true;
	if (need === 'read' && scopes.includes('write')) return true;
	return false;
}

/** `Authorization: Bearer <token>` → token, or null. Case-insensitive scheme. */
export function extractBearer(header: string | null | undefined): string | null {
	if (!header) return null;
	const m = /^bearer\s+(.+)$/i.exec(header.trim());
	const token = m?.[1]?.trim();
	return token ? token : null;
}

export function parseIdParam(raw: string | null | undefined): number | null {
	if (raw == null || raw === '') return null;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

export function parseLimitParam(
	raw: string | null | undefined,
	def = API_DEFAULT_LIMIT,
	max = API_MAX_LIMIT
): number {
	if (raw == null || raw === '') return def;
	const n = Number(raw);
	if (!Number.isFinite(n)) return def;
	return Math.min(max, Math.max(1, Math.floor(n)));
}

/** Cursor pagination: opaque cursor = last seen numeric id. */
export function parseCursor(raw: string | null | undefined): number | null {
	if (raw == null || raw === '') return null;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

const FILTERS = new Set(['today', 'saved', 'all', 'recommended']);

export function parseFilter(raw: string | null | undefined): string | null {
	if (raw == null || raw === '') return null;
	return FILTERS.has(raw) ? raw : null;
}

export function parseOptionalInt(raw: string | null | undefined): number | undefined {
	if (raw == null || raw === '') return undefined;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function invalidFilter(): string {
	return 'Invalid filter (today|saved|all|recommended)';
}
