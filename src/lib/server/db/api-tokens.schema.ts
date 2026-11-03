import { index, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.schema';

// Long-lived Bearer tokens for the public API (v1). Only the sha256 hash is
// stored; the plaintext (`chl_` + base64url) is shown once at creation.
// Session cookies keep working for browser UI — tokens are for integrations.
export const apiToken = pgTable(
	'api_token',
	{
		id: serial('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		/** Human label from the Settings screen. */
		name: text('name').notNull(),
		/** Public prefix (`chl_…`) used to look the row up before hashing. */
		prefix: text('prefix').notNull(),
		/** Hex sha256 of the full plaintext token. */
		tokenHash: text('token_hash').notNull(),
		/** Subset of ['read','write']. Write implies read. */
		scopes: text('scopes').notNull().default('read'),
		lastUsedAt: timestamp('last_used_at'),
		expiresAt: timestamp('expires_at'),
		revokedAt: timestamp('revoked_at'),
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('api_token_prefix_idx').on(t.prefix),
		index('api_token_user_idx').on(t.userId)
	]
);

export type ApiToken = typeof apiToken.$inferSelect;
export type NewApiToken = typeof apiToken.$inferInsert;
