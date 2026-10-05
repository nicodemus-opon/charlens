// Re-tag every article with the v6 pipeline (unanchored tags + closed topic
// taxonomy) and reconcile stale title-echo enrich tags.
//
// NOTE: steady-state healing now runs automatically via the background
// consolidate job (src/lib/server/enrich/consolidate.ts, hourly gate in the
// feed scheduler). This script remains for manual full-corpus backfills.
//
// Usage:
//   pnpm exec tsx scripts/retopic.ts                   # dry run (no writes)
//   pnpm exec tsx scripts/retopic.ts --apply           # re-tag + reconcile
//   pnpm exec tsx scripts/retopic.ts --apply --limit 50
//
// tsx-safe by design: only dependency-free enrich modules are imported
// (keywords, topics keyword-fallback), so this runs without the SvelteKit
// $env runtime. Topics written here are the keyword-fallback buckets — still
// the closed taxonomy, just without embedding cosine. New articles going
// forward get semantic topics via enrichArticle(); to force a semantic pass
// over old rows later, delete their article_embedding rows and let the
// scheduler re-enrich.
//
// --apply per article (newest first):
//  1. Fresh tags/topics/entities via extractTopics + classifyKeywordTopics.
//  2. article_embedding topics/entities are overwritten (the stored vector,
//     when present, is preserved).
//  3. Enrich links whose tag is NOT in the fresh set are deleted, so old
//     title-word tags disappear. Manual/feed links are never touched.
//  4. Orphan tags (zero links) are deleted at the end.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, desc, eq, sql } from 'drizzle-orm';
import { article, articleEmbedding, feed } from '../src/lib/server/db/feeds.schema';
import { articleTag, tag } from '../src/lib/server/db/tags.schema';
import { extractTopics, textFromHtml } from '../src/lib/server/enrich/keywords';
import { computeDocFreq } from '../src/lib/server/enrich/keywords';
import { buildLabelSet } from '../src/lib/server/enrich/labels';
import { classifyKeywordTopics } from '../src/lib/server/enrich/topics';

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = Math.min(5000, Math.max(1, Number(limitArg?.split('=')[1] ?? 500)));

const client = postgres(process.env.DATABASE_URL ?? '', { max: 5 });
const db = drizzle(client);

function norm(name: string): string {
	return name.trim().toLowerCase().slice(0, 60);
}

async function main() {
	const articles = await db
		.select({
			id: article.id,
			feedId: article.feedId,
			title: article.title,
			excerpt: article.excerpt,
			contentHtml: article.contentHtml
		})
		.from(article)
		.orderBy(desc(article.id))
		.limit(LIMIT);
	const feeds = await db.select({ id: feed.id, userId: feed.userId }).from(feed);
	const userByFeed = new Map(feeds.map((f) => [f.id, f.userId]));

	const oldRows = await db
		.select({ articleId: articleTag.articleId, tagId: articleTag.tagId, name: tag.name })
		.from(articleTag)
		.innerJoin(tag, eq(tag.id, articleTag.tagId))
		.where(eq(articleTag.source, 'enrich'));
	const oldByArticle = new Map<number, { tagId: number; name: string }[]>();
	for (const r of oldRows) {
		const list = oldByArticle.get(r.articleId) ?? [];
		list.push({ tagId: r.tagId, name: r.name });
		oldByArticle.set(r.articleId, list);
	}

	// Fresh plan per article (sync, no model — same in both modes). Topics and
	// tags are one label set (labels.ts): taxonomy buckets lead, specifics
	// fill the rest. The corpus snapshot powers the adaptive boilerplate
	// veto (same rule as the live enrich path).
	const stripped = new Map<number, string>();
	for (const a of articles) {
		stripped.set(a.id, textFromHtml(a.contentHtml).slice(0, 5000) || (a.excerpt ?? ''));
	}
	const corpus = {
		size: articles.length,
		docFreq: computeDocFreq(articles.map((a) => `${a.title ?? ''} ${stripped.get(a.id) ?? ''}`))
	};
	const planned = new Map<number, { tags: string[]; topics: string[]; entities: string[] }>();
	for (const a of articles) {
		const text = stripped.get(a.id) ?? '';
		const out = extractTopics({ title: a.title, text }, 12, corpus);
		const labels = buildLabelSet({
			topics: classifyKeywordTopics(a.title, text),
			tags: out.tags,
			entities: out.entities
		});
		planned.set(a.id, { tags: labels, topics: labels, entities: out.entities });
	}
	const emptyTags = [...planned.values()].filter((p) => p.tags.length === 0).length;
	const emptyTopics = [...planned.values()].filter((p) => p.topics.length === 0).length;
	console.log(
		`articles=${articles.length} would-have-zero-tags=${emptyTags} ` +
			`would-have-zero-topics=${emptyTopics} mode=${APPLY ? 'APPLY' : 'dry-run'}`
	);

	const step = Math.max(1, Math.floor(articles.length / 30));
	let shown = 0;
	for (let i = 0; i < articles.length && shown < 30; i += step) {
		const a = articles[i];
		const p = planned.get(a.id)!;
		const oldTags = oldByArticle.get(a.id) ?? [];
		console.log(`  #${a.id} ${(a.title ?? '').slice(0, 60)}`);
		console.log(`    old: [${oldTags.map((t) => t.name).join(', ')}]`);
		console.log(`    new: [${p.tags.join(', ')}]`);
		shown += 1;
	}

	if (!APPLY) {
		console.log('dry run: no writes. Re-run with --apply to re-tag + reconcile.');
		await client.end();
		return;
	}

	const tagIdCache = new Map<string, number>();
	async function ensureTagId(userId: string, name: string): Promise<number | null> {
		const clean = norm(name);
		if (!clean) return null;
		const key = `${userId}\t${clean}`;
		const hit = tagIdCache.get(key);
		if (hit) return hit;
		const existing = await db
			.select({ id: tag.id })
			.from(tag)
			.where(and(eq(tag.userId, userId), eq(tag.name, clean)))
			.limit(1);
		if (existing[0]) {
			tagIdCache.set(key, existing[0].id);
			return existing[0].id;
		}
		const inserted = await db
			.insert(tag)
			.values({ userId, name: clean })
			.onConflictDoNothing()
			.returning({ id: tag.id });
		if (inserted[0]) {
			tagIdCache.set(key, inserted[0].id);
			return inserted[0].id;
		}
		const retry = await db
			.select({ id: tag.id })
			.from(tag)
			.where(and(eq(tag.userId, userId), eq(tag.name, clean)))
			.limit(1);
		if (retry[0]) tagIdCache.set(key, retry[0].id);
		return retry[0]?.id ?? null;
	}

	let prunedLinks = 0;
	let attached = 0;
	for (const a of articles) {
		const p = planned.get(a.id)!;
		// Overwrite topics/entities; the stored vector (if any) is preserved.
		await db
			.insert(articleEmbedding)
			.values({ articleId: a.id, topics: p.topics, entities: p.entities })
			.onConflictDoUpdate({
				target: articleEmbedding.articleId,
				set: { topics: p.topics, entities: p.entities, embeddedAt: new Date() }
			});
		const userId = userByFeed.get(a.feedId);
		if (!userId) continue;
		const keep = new Set(p.tags.map(norm));
		const old = oldByArticle.get(a.id) ?? [];
		for (const s of old) {
			if (keep.has(norm(s.name))) continue;
			await db
				.delete(articleTag)
				.where(
					and(
						eq(articleTag.articleId, a.id),
						eq(articleTag.tagId, s.tagId),
						eq(articleTag.source, 'enrich')
					)
				);
			prunedLinks += 1;
		}
		for (const name of p.tags) {
			const tagId = await ensureTagId(userId, name);
			if (!tagId) continue;
			await db
				.insert(articleTag)
				.values({ tagId, articleId: a.id, source: 'enrich' })
				.onConflictDoNothing({ target: [articleTag.tagId, articleTag.articleId] });
			attached += 1;
		}
	}
	console.log(`refreshed embeddings, pruned-stale-links=${prunedLinks} attached=${attached}`);

	const orphans = await db
		.delete(tag)
		.where(sql`NOT EXISTS (SELECT 1 FROM ${articleTag} WHERE ${articleTag.tagId} = ${tag.id})`)
		.returning({ id: tag.id });
	console.log(`deleted orphan tags: ${orphans.length}`);
	await client.end();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
