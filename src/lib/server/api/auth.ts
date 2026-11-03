import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { apiToken } from '$lib/server/db/api-tokens.schema';
import {
	extractBearer,
	hasScope,
	scopesFromString,
	scopesToString,
	type ApiScope
} from './validate';

export const API_TOKEN_PREFIX = 'chl_';
const TOKEN_BYTES = 32;
const MAX_TOKENS_PER_USER = 20;
const MAX_NAME_LENGTH = 60;

export interface ApiUser {
	id: string;
	scopes: ApiScope[];
	authMethod: 'token' | 'session';
	tokenPrefix: string | null;
}

export function hashApiToken(plaintext: string): string {
	return createHash('sha256').update(plaintext).digest('hex');
}

/** Mint a new plaintext token (`chl_` + base64url). Pure — persist via createApiToken. */
export function mintPlaintext(): { plaintext: string; prefix: string } {
	const secret = randomBytes(TOKEN_BYTES).toString('base64url');
	return {
		plaintext: `${API_TOKEN_PREFIX}${secret}`,
		prefix: `${API_TOKEN_PREFIX}${secret.slice(0, 8)}`
	};
}

function cleanName(name: unknown): string | null {
	const clean = String(name ?? '')
		.trim()
		.slice(0, MAX_NAME_LENGTH);
	return clean ? clean : null;
}

export async function listApiTokens(userId: string) {
	const rows = await db
		.select({
			id: apiToken.id,
			name: apiToken.name,
			prefix: apiToken.prefix,
			scopes: apiToken.scopes,
			lastUsedAt: apiToken.lastUsedAt,
			expiresAt: apiToken.expiresAt,
			createdAt: apiToken.createdAt
		})
		.from(apiToken)
		.where(and(eq(apiToken.userId, userId), isNull(apiToken.revokedAt)));
	return rows.map((r) => ({ ...r, scopes: scopesFromString(r.scopes) }));
}

export async function createApiToken(
	userId: string,
	input: { name: unknown; scopes?: unknown; expiresAt?: Date | null }
): Promise<{ id: number; plaintext: string; prefix: string; scopes: ApiScope[] }> {
	const name = cleanName(input.name);
	if (!name) throw new Error('Token name is required');
	const { parseApiScopes } = await import('./validate');
	const scopes = parseApiScopes(input.scopes ?? ['read']) ?? ['read'];
	const existing = await db
		.select({ id: apiToken.id })
		.from(apiToken)
		.where(and(eq(apiToken.userId, userId), isNull(apiToken.revokedAt)));
	if (existing.length >= MAX_TOKENS_PER_USER) throw new Error('Token limit reached (20)');
	const { plaintext, prefix } = mintPlaintext();
	const inserted = await db
		.insert(apiToken)
		.values({
			userId,
			name,
			prefix,
			tokenHash: hashApiToken(plaintext),
			scopes: scopesToString(scopes),
			expiresAt: input.expiresAt ?? null
		})
		.returning({ id: apiToken.id });
	return { id: inserted[0].id, plaintext, prefix, scopes };
}

export async function revokeApiToken(userId: string, id: number): Promise<boolean> {
	const rows = await db
		.update(apiToken)
		.set({ revokedAt: new Date() })
		.where(and(eq(apiToken.id, id), eq(apiToken.userId, userId), isNull(apiToken.revokedAt)))
		.returning({ id: apiToken.id });
	return rows.length > 0;
}

async function resolveBearerUser(plaintext: string): Promise<ApiUser | null> {
	if (!plaintext.startsWith(API_TOKEN_PREFIX)) return null;
	const hash = hashApiToken(plaintext);
	// Prefix narrows the lookup; hash comparison is the real gate.
	const candidates = await db.select().from(apiToken).where(isNull(apiToken.revokedAt));
	const row = candidates.find((c) => c.tokenHash === hash);
	if (!row) return null;
	if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
	// Fire-and-forget usage stamp — never block the request on it.
	void db
		.update(apiToken)
		.set({ lastUsedAt: new Date() })
		.where(eq(apiToken.id, row.id))
		.catch(() => undefined);
	return {
		id: row.userId,
		scopes: scopesFromString(row.scopes),
		authMethod: 'token',
		tokenPrefix: row.prefix
	};
}

/**
 * Resolve the caller: Bearer token first, session cookie fallback (helps
 * dogfood the API from the UI). Returns null when unauthenticated.
 */
export async function resolveApiUser(
	request: Request,
	locals: App.Locals
): Promise<ApiUser | null> {
	const bearer = extractBearer(request.headers.get('authorization'));
	if (bearer) {
		try {
			return await resolveBearerUser(bearer);
		} catch (e) {
			console.error('api token lookup failed', e);
			return null;
		}
	}
	if (locals.user) {
		return {
			id: locals.user.id,
			scopes: ['read', 'write'],
			authMethod: 'session',
			tokenPrefix: null
		};
	}
	return null;
}

/** Require auth; returns the user or null (callers map to 401 JSON, never redirect). */
export async function requireApiUser(
	request: Request,
	locals: App.Locals
): Promise<ApiUser | null> {
	return resolveApiUser(request, locals);
}

export function requireScope(user: ApiUser, scope: ApiScope): boolean {
	return hasScope(user.scopes, scope);
}
