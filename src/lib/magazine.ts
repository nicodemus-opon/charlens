import type { ArticleRow } from '$lib/article.js';
import type { TagRef } from '$lib/tags.js';

/** One journalist-style desk: the stories filed under a single AI topic. */
export interface TopicDesk {
	tag: TagRef;
	articles: ArticleRow[];
}

export interface MagazineSections {
	lead: ArticleRow | null;
	secondary: ArticleRow[];
	/** Topic desks built from the AI tags on the remaining stories. */
	desks: TopicDesk[];
	latest: ArticleRow[];
	rest: ArticleRow[];
}

const MAX_DESKS = 3;
const MIN_DESK_STORIES = 2;
const MAX_DESK_STORIES = 3;
const MAX_LATEST = 10;

/**
 * Groups stories into topic desks from their AI tags.
 *
 * Topics are ranked by how many stories carry them (ties broken by name so
 * the front page is deterministic), then each story is filed under its
 * first-ranked desk so no story appears twice. Topics with fewer than
 * `minStories` never earn a desk — the page degrades to hero + latest.
 */
export function buildTopicDesks(
	articles: ArticleRow[],
	opts: { maxDesks?: number; minStories?: number; maxStories?: number } = {}
): TopicDesk[] {
	const maxDesks = opts.maxDesks ?? MAX_DESKS;
	const minStories = opts.minStories ?? MIN_DESK_STORIES;
	const maxStories = opts.maxStories ?? MAX_DESK_STORIES;

	const counts = new Map<number, { tag: TagRef; count: number }>();
	for (const a of articles) {
		for (const t of a.tags) {
			const found = counts.get(t.id);
			if (found) found.count += 1;
			else counts.set(t.id, { tag: t, count: 1 });
		}
	}
	const ranked = [...counts.values()]
		.filter((c) => c.count >= minStories)
		.sort((a, b) => b.count - a.count || a.tag.name.localeCompare(b.tag.name))
		.slice(0, maxDesks);
	if (ranked.length === 0) return [];

	const buckets = new Map<number, ArticleRow[]>();
	for (const r of ranked) buckets.set(r.tag.id, []);
	for (const a of articles) {
		const desk = ranked.find((r) => a.tags.some((t) => t.id === r.tag.id));
		if (!desk) continue;
		const bucket = buckets.get(desk.tag.id);
		if (bucket && bucket.length < maxStories) bucket.push(a);
	}
	return ranked
		.map((r) => ({ tag: r.tag, articles: buckets.get(r.tag.id) ?? [] }))
		.filter((d) => d.articles.length > 0);
}

/**
 * Lays out the front page like an editor.
 *
 * The lead prefers an unread story with an image; the next two stories back
 * it up. Everything after the hero is filed into topic desks from the AI
 * tags, and whatever has no desk beat lands in Latest, then More headlines.
 * Filtering (Today, feed, collection, search) scopes the whole edition.
 */
export function buildMagazineSections(articles: ArticleRow[]): MagazineSections {
	if (articles.length === 0) {
		return { lead: null, secondary: [], desks: [], latest: [], rest: [] };
	}
	let leadIndex = articles.findIndex((a) => !a.isRead && a.imageUrl);
	if (leadIndex < 0) leadIndex = articles.findIndex((a) => !a.isRead);
	if (leadIndex < 0) leadIndex = 0;
	const lead = articles[leadIndex];
	const pool = [...articles.slice(0, leadIndex), ...articles.slice(leadIndex + 1)];
	const secondary = pool.slice(0, 2);
	const deskPool = pool.slice(secondary.length);
	const desks = buildTopicDesks(deskPool);
	const inDesk = new Set(desks.flatMap((d) => d.articles.map((a) => a.id)));
	const leftover = deskPool.filter((a) => !inDesk.has(a.id));
	return {
		lead,
		secondary,
		desks,
		latest: leftover.slice(0, MAX_LATEST),
		rest: leftover.slice(MAX_LATEST)
	};
}
