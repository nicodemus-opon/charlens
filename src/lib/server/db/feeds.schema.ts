import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	real,
	serial,
	text,
	timestamp,
	uniqueIndex
} from 'drizzle-orm/pg-core';
import { user } from './auth.schema';

// Feeds and articles are PRIVATE per user: every feed row owns a userId and
// articles are scoped through their feed. Per-user organization lives in
// `collection` (manual groups + smart views defined by rules); the
// subscription points at one collection (one feed → one collection).
// Read/saved state lives in `userArticleState`.
//
// `subscription.category` is legacy: it used to be the free-text group name.
// New code resolves everything through `subscription.collectionId`; the column
// is kept so existing databases migrate lazily (see backfill in rss/refresh)
// and will be dropped in a follow-up migration.

export const collection = pgTable(
	'collection',
	{
		id: serial('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		/** 'manual' groups feeds; 'smart' holds no feeds and resolves `rules` at read time. */
		kind: text('kind').notNull().default('manual'),
		/** Smart-view predicate (SmartRules JSON). Null for manual collections. */
		rules: jsonb('rules'),
		position: integer('position').notNull().default(0),
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('collection_user_name_idx').on(t.userId, t.name),
		index('collection_user_idx').on(t.userId)
	]
);

export const feed = pgTable(
	'feed',
	{
		id: serial('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		url: text('url').notNull(),
		title: text('title').notNull(),
		siteUrl: text('site_url'),
		imageUrl: text('image_url'),
		/** Where this feed came from: direct RSS/Atom vs an RSSHub route. */
		source: text('source').notNull().default('rss'),
		/** RSSHub route path (e.g. /github/trending/daily) when source=rsshub. */
		rsshubRoute: text('rsshub_route'),
		lastFetchedAt: timestamp('last_fetched_at'),
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [uniqueIndex('feed_user_url_idx').on(t.userId, t.url), index('feed_user_idx').on(t.userId)]
);

export const article = pgTable(
	'article',
	{
		id: serial('id').primaryKey(),
		feedId: integer('feed_id')
			.notNull()
			.references(() => feed.id, { onDelete: 'cascade' }),
		guid: text('guid').notNull(),
		title: text('title').notNull(),
		link: text('link').notNull(),
		author: text('author'),
		publishedAt: timestamp('published_at'),
		excerpt: text('excerpt'),
		contentHtml: text('content_html'),
		imageUrl: text('image_url'),
		/** Last successful full-text scrape of the article link. */
		fullFetchedAt: timestamp('full_fetched_at'),
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [uniqueIndex('article_feed_guid_idx').on(t.feedId, t.guid)]
);

export const subscription = pgTable(
	'subscription',
	{
		id: serial('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		feedId: integer('feed_id')
			.notNull()
			.references(() => feed.id, { onDelete: 'cascade' }),
		collectionId: integer('collection_id').references(() => collection.id, {
			onDelete: 'set null'
		}),
		/** @deprecated Use collectionId. Kept for lazy backfill of old rows. */
		category: text('category').notNull().default('General'),
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('subscription_user_feed_idx').on(t.userId, t.feedId),
		index('subscription_feed_idx').on(t.feedId)
	]
);

export const userArticleState = pgTable(
	'user_article_state',
	{
		id: serial('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		articleId: integer('article_id')
			.notNull()
			.references(() => article.id, { onDelete: 'cascade' }),
		isRead: boolean('is_read').notNull().default(false),
		isSaved: boolean('is_saved').notNull().default(false),
		/** Behavioral signals for the Recommended feed (see article_event log). */
		openCount: integer('open_count').notNull().default(0),
		lastOpenedAt: timestamp('last_opened_at'),
		totalDwellMs: integer('total_dwell_ms').notNull().default(0),
		maxScrollPct: integer('max_scroll_pct').notNull().default(0),
		finished: boolean('finished').notNull().default(false),
		updatedAt: timestamp('updated_at').notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('user_article_state_user_article_idx').on(t.userId, t.articleId),
		index('user_article_state_article_idx').on(t.articleId)
	]
);

/** Append-only behavioral log feeding Recommended affinities + future models. */
export const articleEvent = pgTable(
	'article_event',
	{
		id: serial('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		articleId: integer('article_id')
			.notNull()
			.references(() => article.id, { onDelete: 'cascade' }),
		kind: text('kind').notNull(),
		value: integer('value').notNull().default(0),
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [
		index('article_event_user_created_idx').on(t.userId, t.createdAt),
		index('article_event_article_idx').on(t.articleId)
	]
);

/** Phase-2 slot: local 384-dim embeddings + extracted topics/entities. */
export const articleEmbedding = pgTable(
	'article_embedding',
	{
		articleId: integer('article_id')
			.primaryKey()
			.references(() => article.id, { onDelete: 'cascade' }),
		embedding: jsonb('embedding'),
		topics: jsonb('topics'),
		entities: jsonb('entities'),
		embeddedAt: timestamp('embedded_at').notNull().defaultNow()
	},
	(t) => [index('article_embedding_embedded_idx').on(t.embeddedAt)]
);

/** Phase-2 slot: per-user interest vector + preference maps. */
export const userInterest = pgTable('user_interest', {
	userId: text('user_id')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	embedding: jsonb('embedding'),
	topicPrefs: jsonb('topic_prefs'),
	sourcePrefs: jsonb('source_prefs'),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

/**
 * Offline-eval log for the Recommended feed. Written only when
 * RECOMMEND_LOG_SCORES=1 (see refresh.getRecommendedArticles) — never on the
 * hot path by default. No FKs: log rows outlive deleted articles.
 */
export const recommendScoreLog = pgTable(
	'recommend_score_log',
	{
		id: serial('id').primaryKey(),
		userId: text('user_id').notNull(),
		articleId: integer('article_id').notNull(),
		score: real('score').notNull(),
		components: jsonb('components'),
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [index('recommend_score_log_user_created_idx').on(t.userId, t.createdAt)]
);

export type Feed = typeof feed.$inferSelect;
export type NewFeed = typeof feed.$inferInsert;
export type Collection = typeof collection.$inferSelect;
export type NewCollection = typeof collection.$inferInsert;
export type Article = typeof article.$inferSelect;
export type NewArticle = typeof article.$inferInsert;
export type Subscription = typeof subscription.$inferSelect;
export type NewSubscription = typeof subscription.$inferInsert;
export type UserArticleState = typeof userArticleState.$inferSelect;
export type NewUserArticleState = typeof userArticleState.$inferInsert;
export type ArticleEvent = typeof articleEvent.$inferSelect;
export type NewArticleEvent = typeof articleEvent.$inferInsert;
export type ArticleEmbedding = typeof articleEmbedding.$inferSelect;
export type UserInterest = typeof userInterest.$inferSelect;
export type RecommendScoreLog = typeof recommendScoreLog.$inferSelect;
