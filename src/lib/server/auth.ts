import { env } from '$env/dynamic/private';
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { db } from '$lib/server/db';

// charlens is a self-hosted, multi-user app: one instance, one database, many
// accounts. Feeds and articles are private per user (see
// src/lib/server/db/feeds.schema.ts). New accounts start empty.
export const auth = betterAuth({
	appName: 'charlens',
	baseURL: env.ORIGIN,
	secret: env.BETTER_AUTH_SECRET,
	database: drizzleAdapter(db, { provider: 'pg' }),
	emailAndPassword: {
		enabled: true,
		// Self-hosted lockdown: set AUTH_DISABLE_SIGNUP=1 to close registration
		// once every account has been created.
		disableSignUp: env.AUTH_DISABLE_SIGNUP === '1'
	},
	plugins: [
		sveltekitCookies(getRequestEvent) // make sure this is the last plugin in the array
	]
});
