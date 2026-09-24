import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.schema';
import { article } from './feeds.schema';

// User-scoped labels attached to articles (many-to-many). Articles themselves
// are already private per user (owned through feed.userId), but tags carry
// their own userId so listing/ownership never needs a feed join.

export const tag = pgTable(
	'tag',
	{
		id: serial('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [uniqueIndex('tag_user_name_idx').on(t.userId, t.name), index('tag_user_idx').on(t.userId)]
);

export const articleTag = pgTable(
	'article_tag',
	{
		id: serial('id').primaryKey(),
		tagId: integer('tag_id')
			.notNull()
			.references(() => tag.id, { onDelete: 'cascade' }),
		articleId: integer('article_id')
			.notNull()
			.references(() => article.id, { onDelete: 'cascade' }),
		// Provenance so junk cleanup never touches hand-applied tags:
		// 'feed' (RSS <category> on ingest), 'enrich' (keyword extractor),
		// 'manual' (user edit dialogs). Existing rows backfill as 'enrich'.
		source: text('source').notNull().default('enrich'),
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('article_tag_tag_article_idx').on(t.tagId, t.articleId),
		index('article_tag_article_idx').on(t.articleId),
		index('article_tag_tag_idx').on(t.tagId)
	]
);

export type Tag = typeof tag.$inferSelect;
export type NewTag = typeof tag.$inferInsert;
export type ArticleTag = typeof articleTag.$inferSelect;
export type NewArticleTag = typeof articleTag.$inferInsert;
