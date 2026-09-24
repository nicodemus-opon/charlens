// One-off junk-tag cleanup + re-tag with the v3 extractor.
//
// Usage:
//   pnpm exec tsx scripts/clean-tags.ts            # dry run (no writes)
//   pnpm exec tsx scripts/clean-tags.ts --apply    # delete junk, re-tag, drop orphans
//
// Rules:
// - A tag is JUNK when it matches extractor chrome patterns: exact denylist,
//   relative-time ("3 hrs ago"), URL/host shards, digit-mixed shards, duplicate
//   word bigrams ("page page"), or filler-verb bigrams ("costs put").
// - Existing `article_tag` rows all backfilled as source='enrich'. On --apply,
//   enrich links are deleted UNLESS the tag is widely used (usage>=2 across the
//   DB) and not junk — this preserves real feed categories (infoq,
//   architecture & design) while dropping per-article junk.
// - Manual/feed links are never touched (source != 'enrich').
// - Every article is re-run through the v2 extractor: article_embedding
//   topics/entities are refreshed and new enrich tags attached.
// - Orphan tags (zero links) are deleted at the end.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, sql } from 'drizzle-orm';
import { article, articleEmbedding, feed } from '../src/lib/server/db/feeds.schema';
import { articleTag, tag } from '../src/lib/server/db/tags.schema';
import { extractTopics, textFromHtml } from '../src/lib/server/enrich/keywords';

const APPLY = process.argv.includes('--apply');

const client = postgres(process.env.DATABASE_URL ?? '', { max: 5 });
const db = drizzle(client);

const EXACT_JUNK = new Set([
	'page page',
	'page',
	'pages',
	'http',
	'https',
	'www',
	'html',
	'81rc',
	'ago',
	'min ago',
	'mins ago',
	'min',
	'mins',
	'hrs ago',
	'hrs',
	'secs ago',
	'secs',
	// Verified sidebar/ad junk (each checked against every article carrying it).
	'secure payments kenya',
	'flash sale',
	'gentrix osano school',
	'united nations general assembly',
	'java9',
	// Plural dup of a canonical tag ("incident").
	'incidents'
]);

const CHROME = new Set([
	'http',
	'https',
	'www',
	'html',
	'htm',
	'com',
	'cn',
	'net',
	'org',
	'gov',
	'edu',
	'php',
	'aspx',
	'jsp',
	'url',
	'page',
	'pages',
	'81rc'
]);

// Filler verbs/generic nouns whose presence marks a bigram as junk
// ("costs put", "engine behind", "little bit", "learn babies").
const FILLER = new Set(
	(
		'let,lets,make,made,take,put,get,got,go,goes,going,come,comes,think,thinks,' +
		'mean,means,seem,seems,look,looks,turn,turns,swirl,swirls,help,helps,keep,keeps,' +
		'start,starts,deal,deals,win,wins,learn,behind,without,end,side,back,little,bit,' +
		'lot,lots,kind,sort,thing,things,stuff,way,ways,become,becomes,becoming,done,' +
		'ahead,around,right,left,write,ones,know,move,run,runs,running,lesson,actually,' +
		'refuse,something,learned,want,wants,talk,talks,long,short,fix,fixed,please,' +
		'cheap,additional,breakdown,understand,hate,measurable,boost,eye,eyes,stop,stops,' +
		'build,built,era,existing,limit,limited,well,lead,lost,deliver,delivered,' +
		'delivering,despite,robust,peer,opaque,mystery,question,topic,set,spot,' +
		'industrial,related,return,sight,shouldn,raise,failed,mull,happen,held,' +
		'promise,promised,opinion,making,tell,told,exist,grow,seiz,park,green,cold,' +
		'rich,economic,design,designing,pressure,heat,regime,bonus,baby,availability,' +
		'rule,master,mall,pretend,pretending,production,taxing,normalise,normalised,' +
		'normalize,normalized,climb,climbed,climbing,don,launch,unexpected,capital,' +
		'domestic,declare,declared,gain,guide,fair,app,career,lender,deployment,' +
		'delivery,meant,ocean,risk,turning,demand,increase,increasing,' +
		'increased,dim,test,testing,insane,insanely,special,trainer,concern,stupid,' +
		'chair,trust,trusting,trusted,memory,future,face,weapon,compile,owned,' +
		'budding,buy,upbeat,job,jobless,tried,speak,speaks,speaking,spoke,finally,' +
		'final,pilot,kill,kills,killed,killing,favorite,clone,clones,cloned,double,' +
		'dream,career,compliance,illicit,release,released,releasing,powered,tap,' +
		'hurdle,tech,feature,enough,age,starting,started,stay,stayed,stays,pin,' +
		'pinned,deprecate,deprecated,deprecating,catch,faster,fastest,fast,slow,' +
		'slower,slowest,worse,worst,bad,four,five,six,seven,eight,nine,ten,score,' +
		'stage,vendor,practitioner,provider,multi,ship,shipping,shipped,anyway,' +
		'safe,beat,spelling,spell,facility,caught,worth,raising,incredible,' +
		'interim,word,slowed,hit,break,cup,logistic,trained,offered,offer,' +
		'offering,compliant,building,pass,highest,higher,enable,enabled,' +
		'enabling,protect,protected,protecting,case,compress,compressed,' +
		'compressing'
	).split(',')
);

// Standalone generic nouns: junk only as single-word tags ("model", "power").
// Mirrors GENERIC_NOUNS in the extractor; multi-word tags are left alone.
const GENERIC = new Set(
	(
		'agent,area,bank,big,business,code,coding,cost,county,engine,experience,' +
		'european,finance,firm,good,group,high,investor,knowledge,land,market,' +
		'model,official,plant,policy,power,price,program,project,property,rate,' +
		'record,resource,school,sector,service,solid,state,study,system,team,top'
	).split(',')
);

function singularize(w: string): string {
	if (w.length <= 3) return w;
	if (w.endsWith('ies') && w.length > 5) return w.slice(0, -3) + 'y';
	if (/(ses|xes|zes|ches|shes)$/.test(w) && w.length > 5) return w.slice(0, -2);
	if (w.endsWith('s') && !/(ss|us)$/.test(w)) return w.slice(0, -1);
	return w;
}

export function isJunkTag(name: string): boolean {
	const n = name.trim().toLowerCase();
	if (!n) return true;
	if (EXACT_JUNK.has(n)) return true;
	if (/\b\d+\s*(secs?|mins?|hrs?|hours?|days?|weeks?)\s+ago\b/.test(n)) return true;
	const parts = n.split(/\s+/);
	if (parts.length === 2 && singularize(parts[0]) === singularize(parts[1])) return true;
	// Single-letter shards ("kenya g") are never real tags ('&' excepted).
	if (parts.some((p) => p.length < 2 && p !== '&')) return true;
	if (parts.length === 1 && GENERIC.has(singularize(n))) return true;
	for (const p of parts) {
		const s = singularize(p);
		if (CHROME.has(p) || CHROME.has(s)) return true;
		if (FILLER.has(p) || FILLER.has(s)) return true;
		if (GENERIC.has(p) || GENERIC.has(s)) return true;
		// digit-mixed shards ("sh26", "81rc", "70mw", "9bn")
		if (/[a-z]/.test(p) && /[0-9]/.test(p) && p.length < 5) return true;
		if (/^\d+[a-z]+$/.test(p) || /^[a-z]+\d+$/.test(p)) return true;
	}
	return false;
}

async function main() {
	const usageRows = await db
		.select({
			id: tag.id,
			name: tag.name,
			uses: sql<number>`count(${articleTag.articleId})`.mapWith(Number)
		})
		.from(tag)
		.leftJoin(articleTag, eq(articleTag.tagId, tag.id))
		.groupBy(tag.id, tag.name);
	const usage = new Map(usageRows.map((r) => [r.id, { name: r.name, uses: r.uses ?? 0 }]));
	const junk = [...usage.values()].filter((t) => isJunkTag(t.name));
	console.log(`tags=${usage.size} junk=${junk.length} mode=${APPLY ? 'APPLY' : 'dry-run'}`);
	console.log(
		'top junk:',
		junk
			.sort((a, b) => b.uses - a.uses)
			.slice(0, 20)
			.map((t) => `${t.name} x${t.uses}`)
			.join(', ')
	);

	const articles = await db
		.select({
			id: article.id,
			feedId: article.feedId,
			title: article.title,
			excerpt: article.excerpt,
			contentHtml: article.contentHtml
		})
		.from(article);
	const feeds = await db.select({ id: feed.id, userId: feed.userId }).from(feed);
	const userByFeed = new Map(feeds.map((f) => [f.id, f.userId]));

	// New tags per article under the v2 extractor (computed in both modes).
	const planned = new Map<number, { tags: string[]; topics: string[]; entities: string[] }>();
	for (const a of articles) {
		const text = textFromHtml(a.contentHtml).slice(0, 5000) || (a.excerpt ?? '');
		const out = extractTopics({ title: a.title, text });
		planned.set(a.id, { tags: out.tags, topics: out.topics, entities: out.entities });
	}
	const emptyCount = [...planned.values()].filter((p) => p.tags.length === 0).length;
	console.log(`articles=${articles.length} would-have-zero-keyword-tags=${emptyCount}`);

	// Old-vs-new side-by-side (phase-0 eval view): current enrich tags from
	// the DB next to what the extractor would produce now. Sampled evenly
	// across the corpus, not just the newest 12, so the dry run is a usable
	// eyeball metric (junk-rate / empty-rate) before any --apply.
	const oldRows = await db
		.select({ articleId: articleTag.articleId, name: tag.name })
		.from(articleTag)
		.innerJoin(tag, eq(tag.id, articleTag.tagId))
		.where(eq(articleTag.source, 'enrich'));
	const oldByArticle = new Map<number, string[]>();
	for (const r of oldRows) {
		const list = oldByArticle.get(r.articleId) ?? [];
		list.push(r.name);
		oldByArticle.set(r.articleId, list);
	}
	const sampleStep = Math.max(1, Math.floor(articles.length / 30));
	let shown = 0;
	for (let i = 0; i < articles.length && shown < 30; i += sampleStep) {
		const a = articles[i];
		const p = planned.get(a.id)!;
		const oldTags = oldByArticle.get(a.id) ?? [];
		console.log(`  #${a.id} ${(a.title ?? '').slice(0, 60)}`);
		console.log(`    old: [${oldTags.join(', ')}]`);
		console.log(`    new: [${p.tags.join(', ')}]`);
		shown += 1;
	}

	if (!APPLY) {
		console.log('dry run: no writes. Re-run with --apply to delete + re-tag.');
		await client.end();
		return;
	}

	// Tags to preserve: used more than once AND not junk (feed categories etc).
	const keepTagIds = [...usage.entries()]
		.filter(([, t]) => t.uses >= 2 && !isJunkTag(t.name))
		.map(([id]) => id);
	console.log(`preserving ${keepTagIds.length} widely-used non-junk tags`);

	// Snapshot surviving tag names per article so fresh tags that duplicate
	// them (substring or word-order, e.g. "agent coding" vs "coding agents")
	// are skipped instead of co-attached.
	const surviving = new Map<number, string[]>();
	if (keepTagIds.length > 0) {
		const keptLinks = await db
			.select({ articleId: articleTag.articleId, name: tag.name })
			.from(articleTag)
			.innerJoin(tag, eq(tag.id, articleTag.tagId))
			.where(
				sql`${articleTag.tagId} IN (${sql.join(
					keepTagIds.map((id) => sql`${id}`),
					sql`, `
				)})`
			);
		for (const row of keptLinks) {
			const list = surviving.get(row.articleId) ?? [];
			list.push(row.name);
			surviving.set(row.articleId, list);
		}
	}
	function bagKey(name: string): string {
		return name
			.split(/\s+/)
			.map((w) => singularize(w))
			.sort()
			.join(' ');
	}
	function coveredBy(names: string[], w: string): boolean {
		return names.some((t) => t === w || t.includes(w) || w.includes(t) || bagKey(t) === bagKey(w));
	}

	// 1. Delete non-preserved enrich links (manual/feed links untouched).
	const notIn =
		keepTagIds.length > 0
			? sql` AND ${articleTag.tagId} NOT IN (${sql.join(
					keepTagIds.map((id) => sql`${id}`),
					sql`, `
				)})`
			: sql``;
	const removed = await db
		.delete(articleTag)
		.where(and(eq(articleTag.source, 'enrich'), sql`true${notIn}`))
		.returning({ id: articleTag.id });
	console.log(`removed enrich links: ${removed.length}`);

	// 2. Re-tag every article + refresh embedding topics/entities.
	const tagIdCache = new Map<string, number>();
	// Per-user singular-form index so plural dups ("coding agents" vs an
	// existing "coding agent") reuse one tag row instead of forking.
	const singularIndex = new Map<string, Map<string, number>>();
	async function userSingularIndex(userId: string): Promise<Map<string, number>> {
		const hit = singularIndex.get(userId);
		if (hit) return hit;
		const rows = await db
			.select({ id: tag.id, name: tag.name })
			.from(tag)
			.where(eq(tag.userId, userId));
		const m = new Map<string, number>();
		for (const r of rows) {
			const key = r.name
				.split(/\s+/)
				.map((w) => singularize(w))
				.join(' ');
			if (!m.has(key) || r.id < (m.get(key) ?? Infinity)) m.set(key, r.id);
		}
		singularIndex.set(userId, m);
		return m;
	}
	function singularKey(name: string): string {
		return name
			.split(/\s+/)
			.map((w) => singularize(w))
			.join(' ');
	}
	async function ensureTagId(userId: string, name: string): Promise<number | null> {
		const clean = name.trim().toLowerCase().slice(0, 60);
		if (!clean || isJunkTag(clean)) return null;
		const key = `${userId}	${clean}`;
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
		// Singular/plural dup? Reuse the surviving row (e.g. "coding agent").
		const fuzzy = (await userSingularIndex(userId)).get(singularKey(clean));
		if (fuzzy) {
			tagIdCache.set(key, fuzzy);
			return fuzzy;
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

	let attached = 0;
	for (const a of articles) {
		const p = planned.get(a.id)!;
		await db
			.insert(articleEmbedding)
			.values({ articleId: a.id, topics: p.topics, entities: p.entities })
			.onConflictDoUpdate({
				target: articleEmbedding.articleId,
				set: { topics: p.topics, entities: p.entities, embeddedAt: new Date() }
			});
		const userId = userByFeed.get(a.feedId);
		if (!userId) continue;
		const already = surviving.get(a.id) ?? [];
		for (const name of p.tags.slice(0, 5)) {
			if (coveredBy(already, name)) continue;
			const tagId = await ensureTagId(userId, name);
			if (!tagId) continue;
			await db
				.insert(articleTag)
				.values({ tagId, articleId: a.id, source: 'enrich' })
				.onConflictDoNothing({ target: [articleTag.tagId, articleTag.articleId] });
			attached += 1;
		}
	}
	console.log(`refreshed embeddings + attached enrich links: ${attached}`);

	// 3. Delete orphan tags (zero links — safe by definition).
	const orphans = await db
		.delete(tag)
		.where(sql`NOT EXISTS (SELECT 1 FROM ${articleTag} WHERE ${articleTag.tagId} = ${tag.id})`)
		.returning({ id: tag.id });
	console.log(`deleted orphan tags: ${orphans.length}`);

	const after = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(tag);
	const afterLinks = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(articleTag);
	console.log(`after: tags=${after[0]?.n} links=${afterLinks[0]?.n}`);
	await client.end();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
