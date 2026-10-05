import { env } from '$env/dynamic/private';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { articleTag, tag } from '$lib/server/db/tags.schema';
import { bagKey, isJunkTag, singularKey } from './tag-hygiene';
import { embedTexts } from './embeddings';
import { cosineSimilarity } from '$lib/server/recommend/score';

// Background tag consolidation: heals automatic-tag drift that the ingest
// path never revisits (extractor improvements, corpus shifts, plural/word-
// order forks, per-article junk like "3 hrs ago").
//
// Safety invariants (enrich-only, per user):
// - Only `article_tag` rows with source='enrich' are repointed/deleted.
//   Manual/feed links are never touched; a tag carrying any non-enrich link
//   is never deleted (it survives as the manual label even if its name is
//   junk by heuristic rules).
// - Junk auto-delete is restricted to low-value tags (<=1 enrich use, zero
//   protected uses). Widely-used junk is left for manual review — the legacy
//   one-off script was more aggressive; this job is intentionally the safe
//   subset that can run unattended.
// - Merges repoint enrich links (insert-winner-then-delete-loser, conflict-
//   safe) and delete the loser row only when it ends with zero links.
// - String merges (singular/plural, word-order bags) run without the model;
//   semantic merges need MiniLM and degrade to "string pass only" when the
//   model is unavailable.

export interface MergePlan {
	loserId: number;
	loserName: string;
	winnerId: number;
	winnerName: string;
	reason: 'singular' | 'bag' | 'semantic';
	similarity?: number;
}

export interface ConsolidateUserResult {
	userId: string;
	checked: number;
	merged: number;
	prunedLinks: number;
	deletedTags: number;
	skippedProtected: number;
}

export interface ConsolidateAllResult {
	usersChecked: number;
	merged: number;
	prunedLinks: number;
	deletedTags: number;
	skipped: number;
}

export type EmbedBatch = (texts: string[]) => Promise<(number[] | null)[]>;

function parseClamped(raw: string | undefined, fallback: number, min: number, max: number): number {
	const n = Number(raw ?? fallback);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

export function isTagConsolidateEnabled(raw?: string): boolean {
	return (raw ?? env.TAG_CONSOLIDATE_ENABLED ?? '1') !== '0';
}

export function getTagConsolidateIntervalH(raw?: string): number {
	return parseClamped(raw ?? env.TAG_CONSOLIDATE_INTERVAL_H ?? '1', 1, 1, 168);
}

export function getTagConsolidateMaxUsers(raw?: string): number {
	return Math.round(parseClamped(raw ?? env.TAG_CONSOLIDATE_MAX_USERS ?? '20', 20, 1, 100));
}

export function getTagConsolidateMaxMergesPerUser(raw?: string): number {
	return Math.round(parseClamped(raw ?? env.TAG_CONSOLIDATE_MAX_MERGES ?? '10', 10, 1, 50));
}

export function getTagConsolidateMinSimilarity(raw?: string): number {
	const n = Number(raw ?? env.TAG_CONSOLIDATE_MIN_SIM ?? '0.92');
	if (!Number.isFinite(n)) return 0.92;
	return Math.min(0.99, Math.max(0.8, n));
}

/** Hourly gate: true when never ran or the interval has elapsed. */
export function shouldRunConsolidation(
	lastRunAtIso: string | null,
	nowMs = Date.now(),
	intervalH?: number
): boolean {
	if (!lastRunAtIso) return true;
	const at = Date.parse(lastRunAtIso);
	if (!Number.isFinite(at)) return true;
	const intervalMs = (intervalH ?? getTagConsolidateIntervalH()) * 60 * 60 * 1000;
	return nowMs - at >= intervalMs;
}

export interface TagUsage {
	id: number;
	name: string;
	enrichUses: number;
	protectedUses: number;
}

/**
 * Pure string-merge planner: group tags sharing a singularKey (plural dups)
 * or bagKey (word-order dups). Canonical prefers non-junk, then lowest id so
 * `?tag=<id>` filter links stay stable. Junk-only groups still collapse to
 * the oldest row (junk prune runs separately).
 */
export function planStringMerges(tags: { id: number; name: string }[]): MergePlan[] {
	const plans: MergePlan[] = [];
	const byKey = new Map<string, { id: number; name: string; kind: 'singular' | 'bag' }[]>();
	const assigned = new Set<number>();

	for (const t of tags) {
		const key = `s:${singularKey(t.name)}`;
		const list = byKey.get(key) ?? [];
		list.push({ ...t, kind: 'singular' });
		byKey.set(key, list);
	}
	for (const [, group] of byKey) {
		if (group.length < 2) continue;
		const sorted = [...group].sort((a, b) => {
			const ja = isJunkTag(a.name) ? 1 : 0;
			const jb = isJunkTag(b.name) ? 1 : 0;
			return ja - jb || a.id - b.id;
		});
		const winner = sorted[0];
		for (const loser of sorted.slice(1)) {
			if (assigned.has(loser.id)) continue;
			assigned.add(loser.id);
			plans.push({
				loserId: loser.id,
				loserName: loser.name,
				winnerId: winner.id,
				winnerName: winner.name,
				reason: 'singular'
			});
		}
	}
	// Bag pass only for tags not already merged (superset of singular groups).
	const remaining = tags.filter((t) => ![...assigned].includes(t.id));
	const byBag = new Map<string, { id: number; name: string }[]>();
	for (const t of remaining) {
		const key = `b:${bagKey(t.name)}`;
		const list = byBag.get(key) ?? [];
		list.push(t);
		byBag.set(key, list);
	}
	for (const [, group] of byBag) {
		if (group.length < 2) continue;
		// Skip single-token bags: singular pass already handled them, and a
		// 1-token bag would merge unrelated tags sharing a stemmed token.
		if (!group[0].name.trim().includes(' ')) continue;
		const sorted = [...group].sort((a, b) => {
			const ja = isJunkTag(a.name) ? 1 : 0;
			const jb = isJunkTag(b.name) ? 1 : 0;
			return ja - jb || a.id - b.id;
		});
		const winner = sorted[0];
		for (const loser of sorted.slice(1)) {
			if (assigned.has(loser.id)) continue;
			// Same singular form was already merged above; bag adds reordered
			// variants (e.g. "agent coding" → "coding agent").
			if (singularKey(loser.name) === singularKey(winner.name)) continue;
			assigned.add(loser.id);
			plans.push({
				loserId: loser.id,
				loserName: loser.name,
				winnerId: winner.id,
				winnerName: winner.name,
				reason: 'bag'
			});
		}
	}
	return plans;
}

/**
 * Pure semantic-merge planner over precomputed tag-name embeddings. Greedy:
 * pairs above threshold, strongest first; each tag merges at most once.
 * Winner prefers higher use, then non-junk, then lowest id.
 */
export function planSemanticMerges(
	tags: { id: number; name: string; enrichUses: number }[],
	vectors: Map<number, number[]>,
	minSim: number
): MergePlan[] {
	const pairs: { a: number; b: number; sim: number }[] = [];
	for (let i = 0; i < tags.length; i++) {
		const va = vectors.get(tags[i].id);
		if (!va) continue;
		for (let j = i + 1; j < tags.length; j++) {
			const vb = vectors.get(tags[j].id);
			if (!vb) continue;
			// String-dup pairs belong to the string pass (exact reason +
			// no model dependence); keep this pass for true synonyms.
			if (singularKey(tags[i].name) === singularKey(tags[j].name)) continue;
			if (bagKey(tags[i].name) === bagKey(tags[j].name)) continue;
			const sim = cosineSimilarity(va, vb);
			if (sim >= minSim) pairs.push({ a: i, b: j, sim });
		}
	}
	pairs.sort((x, y) => y.sim - x.sim);
	const merged = new Set<number>();
	const plans: MergePlan[] = [];
	for (const p of pairs) {
		const ta = tags[p.a];
		const tb = tags[p.b];
		if (merged.has(ta.id) || merged.has(tb.id)) continue;
		const ja = isJunkTag(ta.name) ? 1 : 0;
		const jb = isJunkTag(tb.name) ? 1 : 0;
		let winner = ta;
		let loser = tb;
		if (
			tb.enrichUses > ta.enrichUses ||
			(tb.enrichUses === ta.enrichUses && (jb - ja < 0 || (jb === ja && tb.id < ta.id)))
		) {
			winner = tb;
			loser = ta;
		}
		merged.add(winner.id);
		merged.add(loser.id);
		plans.push({
			loserId: loser.id,
			loserName: loser.name,
			winnerId: winner.id,
			winnerName: winner.name,
			reason: 'semantic',
			similarity: Math.round(p.sim * 1000) / 1000
		});
	}
	return plans;
}

/** Tags safe to auto-prune: junk by heuristic, no manual/feed links, low enrich use. */
export function findPrunableJunkTags(tags: TagUsage[]): TagUsage[] {
	return tags.filter((t) => t.protectedUses === 0 && t.enrichUses <= 1 && isJunkTag(t.name));
}

async function repointEnrichLinks(
	loserId: number,
	winnerId: number
): Promise<{ moved: number; dropped: number }> {
	const loserLinks = await db
		.select({ articleId: articleTag.articleId })
		.from(articleTag)
		.where(and(eq(articleTag.tagId, loserId), eq(articleTag.source, 'enrich')));
	let moved = 0;
	let dropped = 0;
	for (const link of loserLinks) {
		await db
			.insert(articleTag)
			.values({ tagId: winnerId, articleId: link.articleId, source: 'enrich' })
			.onConflictDoNothing({ target: [articleTag.tagId, articleTag.articleId] });
		// If the article already carried the winner tag, the insert above is
		// a no-op and the loser row is simply dropped (dedup, not dup).
		const deleted = await db
			.delete(articleTag)
			.where(
				and(
					eq(articleTag.tagId, loserId),
					eq(articleTag.articleId, link.articleId),
					eq(articleTag.source, 'enrich')
				)
			)
			.returning({ id: articleTag.id });
		if (deleted.length > 0) {
			const still = await db
				.select({ id: articleTag.id })
				.from(articleTag)
				.where(and(eq(articleTag.tagId, winnerId), eq(articleTag.articleId, link.articleId)))
				.limit(1);
			if (still.length > 0) moved += 1;
			else dropped += 1;
		}
	}
	return { moved, dropped };
}

async function deleteTagIfOrphan(tagId: number): Promise<boolean> {
	const links = await db
		.select({ id: articleTag.id })
		.from(articleTag)
		.where(eq(articleTag.tagId, tagId))
		.limit(1);
	if (links.length > 0) return false;
	await db.delete(tag).where(eq(tag.id, tagId));
	return true;
}

async function loadUserTagUsage(userId: string): Promise<TagUsage[]> {
	const rows = await db
		.select({
			id: tag.id,
			name: tag.name,
			enrichUses: sql<number>`count(*) filter (where ${articleTag.source} = 'enrich')`.mapWith(
				Number
			),
			protectedUses: sql<number>`count(*) filter (where ${articleTag.source} != 'enrich')`.mapWith(
				Number
			)
		})
		.from(tag)
		.leftJoin(articleTag, eq(articleTag.tagId, tag.id))
		.where(eq(tag.userId, userId))
		.groupBy(tag.id, tag.name);
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		enrichUses: r.enrichUses ?? 0,
		protectedUses: r.protectedUses ?? 0
	}));
}

/**
 * Consolidate one user's enrich tags: prune low-value junk, merge string
 * dups, merge embedding synonyms, delete orphans. Never touches manual/feed
 * links. Capped by maxMerges so a single user can't monopolize the run.
 */
export async function consolidateUserTags(
	userId: string,
	opts: {
		maxMerges?: number;
		minSimilarity?: number;
		embed?: EmbedBatch;
	} = {}
): Promise<ConsolidateUserResult> {
	const maxMerges = opts.maxMerges ?? getTagConsolidateMaxMergesPerUser();
	const minSim = opts.minSimilarity ?? getTagConsolidateMinSimilarity();
	const embed = opts.embed ?? embedTexts;
	const result: ConsolidateUserResult = {
		userId,
		checked: 0,
		merged: 0,
		prunedLinks: 0,
		deletedTags: 0,
		skippedProtected: 0
	};

	const usage = await loadUserTagUsage(userId);
	result.checked = usage.length;
	if (usage.length === 0) return result;

	// 1. Prune low-value junk (enrich links only; protected tags survive).
	const prunable = findPrunableJunkTags(usage);
	for (const t of prunable) {
		const removed = await db
			.delete(articleTag)
			.where(and(eq(articleTag.tagId, t.id), eq(articleTag.source, 'enrich')))
			.returning({ id: articleTag.id });
		result.prunedLinks += removed.length;
		if (await deleteTagIfOrphan(t.id)) result.deletedTags += 1;
	}
	const prunedIds = new Set(prunable.map((t) => t.id));
	let live: TagUsage[] = usage.filter((t) => !prunedIds.has(t.id));
	for (const t of usage) {
		if (!prunedIds.has(t.id) && t.protectedUses > 0 && isJunkTag(t.name)) {
			result.skippedProtected += 1;
		}
	}

	// 2. String merges (no model needed).
	const stringPlans = planStringMerges(live.map((t) => ({ id: t.id, name: t.name })));
	for (const plan of stringPlans) {
		if (result.merged >= maxMerges) break;
		await repointEnrichLinks(plan.loserId, plan.winnerId);
		if (await deleteTagIfOrphan(plan.loserId)) result.deletedTags += 1;
		result.merged += 1;
	}
	if (stringPlans.length > 0) {
		const mergedLosers = new Set(stringPlans.map((p) => p.loserId));
		live = live.filter((t) => !mergedLosers.has(t.id));
	}

	// 3. Semantic merges (model-dependent; skipped when unavailable).
	if (result.merged < maxMerges && live.length >= 2 && live.length <= 500) {
		try {
			const vectors = await embed(live.map((t) => t.name));
			const vecMap = new Map<number, number[]>();
			live.forEach((t, i) => {
				const v = vectors[i];
				if (v) vecMap.set(t.id, v);
			});
			const semPlans = planSemanticMerges(
				live.map((t) => ({ id: t.id, name: t.name, enrichUses: t.enrichUses })),
				vecMap,
				minSim
			);
			for (const plan of semPlans) {
				if (result.merged >= maxMerges) break;
				await repointEnrichLinks(plan.loserId, plan.winnerId);
				if (await deleteTagIfOrphan(plan.loserId)) result.deletedTags += 1;
				result.merged += 1;
			}
		} catch (e) {
			console.error(`tag consolidate semantic pass failed for user ${userId}`, e);
		}
	}

	// 4. Orphan sweep (zero links — safe by definition, any source).
	const orphans = await db
		.delete(tag)
		.where(
			and(
				eq(tag.userId, userId),
				sql`NOT EXISTS (SELECT 1 FROM ${articleTag} WHERE ${articleTag.tagId} = ${tag.id})`
			)
		)
		.returning({ id: tag.id });
	result.deletedTags += orphans.length;

	return result;
}

/**
 * Consolidate enrich tags across users (called from the scheduler on the
 * hourly gate, not every tick). Capped so a big multi-user instance stays
 * cheap. One user's failure never aborts the run.
 */
export async function consolidateAllUsers(
	opts: {
		maxUsers?: number;
		maxMergesPerUser?: number;
		minSimilarity?: number;
		embed?: EmbedBatch;
	} = {}
): Promise<ConsolidateAllResult> {
	const maxUsers = opts.maxUsers ?? getTagConsolidateMaxUsers();
	const result: ConsolidateAllResult = {
		usersChecked: 0,
		merged: 0,
		prunedLinks: 0,
		deletedTags: 0,
		skipped: 0
	};
	const owners = await db.selectDistinct({ userId: tag.userId }).from(tag).limit(maxUsers);
	for (const row of owners) {
		try {
			const r = await consolidateUserTags(row.userId, {
				maxMerges: opts.maxMergesPerUser,
				minSimilarity: opts.minSimilarity,
				embed: opts.embed
			});
			result.usersChecked += 1;
			result.merged += r.merged;
			result.prunedLinks += r.prunedLinks;
			result.deletedTags += r.deletedTags;
			result.skipped += r.skippedProtected;
		} catch (e) {
			console.error(`tag consolidate failed for user ${row.userId}`, e);
		}
	}
	return result;
}
