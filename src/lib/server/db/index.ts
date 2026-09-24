import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { env } from '$env/dynamic/private';

type Db = ReturnType<typeof drizzle>;

// Lazily initialized: `vite build` imports server modules during postbuild
// analyse without a live DATABASE_URL, so the connection must only open on
// first query at runtime (entrypoint fails fast if the var is missing).
let instance: Db | undefined;

function getDb(): Db {
	if (!instance) {
		const url = env.DATABASE_URL;
		if (!url) throw new Error('DATABASE_URL is not set');
		instance = drizzle(postgres(url), { schema });
	}
	return instance;
}

export const db: Db = new Proxy({} as Db, {
	get(_target, prop) {
		const value = (getDb() as unknown as Record<PropertyKey, unknown>)[prop];
		return typeof value === 'function' ? (value as Function).bind(getDb()) : value;
	}
});
