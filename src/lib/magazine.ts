import type { ArticleRow } from '$lib/article.js';
import type { TagRef } from '$lib/tags.js';

/** Visual weight of a story, derived from its content signals. */
export type StoryEmphasis = 'visual' | 'featured' | 'standard' | 'brief';

/**
 * Nested layout pattern for a topic desk. Chosen from the desk's own
 * content — never at random — so each desk reads differently:
 * - `spotlight`: one image-led story features large, the rest stack beside it.
 * - `symmetric`: a balanced grid (stories are visually even).
 * - `headlines`: text-led stack for desks with no usable imagery.
 */
export type DeskPattern = 'spotlight' | 'symmetric' | 'headlines';

/** One journalist-style desk: the stories filed under a single AI topic. */
export interface TopicDesk {
	tag: TagRef;
	articles: ArticleRow[];
	/** Same stories chunked into clean 12-col rows for the nested grid. */
	rows: GridRow[];
	/** Overflow beyond the grid: compact per-desk tail, never leaks to Latest. */
	more: ArticleRow[];
	/** Nested dynamic pattern for this desk. */
	pattern: DeskPattern;
	/** Id of the spotlight story when `pattern === 'spotlight'`. */
	spotlightId: number | null;
}

/**
 * A story's width inside a strict 12-column row. Only these static spans
 * exist (see `spanClass` in magazine-view): 12, 6, 4, 3.
 * Every row sums to exactly 12, so edges always align - never jagged.
 * Pairs are always an even 6+6: an uneven image/text pair balloons the
 * fixed-ratio thumb into a giant hero beside a squished card.
 */
export type ColSpan = 12 | 6 | 4 | 3;

/** One story placed in a grid row with its column width. */
export interface PlacedStory {
	article: ArticleRow;
	span: ColSpan;
}

/** One clean grid row: spans always sum to 12. */
export interface GridRow {
	stories: PlacedStory[];
}

/**
 * Editorial rhythm block. There is at most ONE latest block (a single Latest
 * header) - the dynamism lives INSIDE each grid via row patterns, not by
 * splitting sections into repeated headers.
 */
export type MagazineBlock = { kind: 'latest'; rows: GridRow[] } | { kind: 'desk'; desk: TopicDesk };

export interface MagazineSections {
	lead: ArticleRow | null;
	secondary: ArticleRow[];
	/** Latest stories that earned no topic desk, shown before the desks. */
	latest: ArticleRow[];
	/** Topic desks built from the AI tags on the remaining stories. */
	desks: TopicDesk[];
	/** Short tail of extra headlines shown last. */
	rest: ArticleRow[];
	/**
	 * Editorial rhythm: desks and latest-story groups interleaved so no two
	 * adjacent blocks share the same shape (unless content forces it).
	 */
	blocks: MagazineBlock[];
}

const MAX_DESKS = 6;
const MIN_DESK_STORIES = 2;
const MAX_DESK_STORIES = 4;
/** Headline rows under a desk grid: the list is capped, not endless. */
const MAX_DESK_MORE = 5;
const MAX_LATEST = 6;
const MAX_MORE = 5;

/**
 * Smart visual weight for one story. Pure content signals — no randomness,
 * no dates, no ids — so the same stories always lay out the same way:
 * - `visual`: has an image (earns the large slot).
 * - `featured`: unread + long read (>= 8 min) or saved.
 * - `brief`: read + short (<= 2 min) and no excerpt.
 * - `standard`: everything else.
 */
export function getStoryEmphasis(a: ArticleRow): StoryEmphasis {
	if (a.imageUrl) return 'visual';
	if (a.isSaved || (!a.isRead && (a.readMinutes ?? 0) >= 8)) return 'featured';
	if (a.isRead && !a.excerpt && (a.readMinutes ?? 2) <= 2) return 'brief';
	return 'standard';
}

function scoreStory(a: ArticleRow): number {
	let score = 0;
	if (a.imageUrl) score += 4;
	if (!a.isRead) score += 2;
	if (a.isSaved) score += 2;
	if ((a.readMinutes ?? 0) >= 8) score += 1;
	if (a.excerpt) score += 1;
	return score;
}

/**
 * Picks the nested pattern for one desk from its own stories:
 * - `headlines`: no story has an image (text-led stack).
 * - `spotlight`: one story clearly outscores the rest AND has an image.
 * - `symmetric`: visually even stories (balanced grid).
 */
export function pickDeskPattern(articles: ArticleRow[]): {
	pattern: DeskPattern;
	spotlightId: number | null;
} {
	if (articles.length === 0) return { pattern: 'symmetric', spotlightId: null };
	if (!articles.some((a) => a.imageUrl)) return { pattern: 'headlines', spotlightId: null };
	const ranked = [...articles].sort((a, b) => scoreStory(b) - scoreStory(a));
	const [top, runner] = [ranked[0], ranked[1]];
	if (top.imageUrl && (!runner || scoreStory(top) - scoreStory(runner) >= 3)) {
		return { pattern: 'spotlight', spotlightId: top.id };
	}
	return { pattern: 'symmetric', spotlightId: null };
}

function toDesk(tag: TagRef, articles: ArticleRow[], gridSize: number): TopicDesk {
	const { pattern, spotlightId } = pickDeskPattern(articles);
	const ordered =
		pattern === 'spotlight' && spotlightId != null
			? [
					articles.find((a) => a.id === spotlightId)!,
					...articles.filter((a) => a.id !== spotlightId)
				]
			: articles;
	// The desk shows the grid plus a capped headline list; anything past
	// that falls through to Latest/rest in buildMagazineSections (View all
	// still reaches the full topic).
	const shown = ordered.slice(0, gridSize);
	const more = ordered.slice(gridSize, gridSize + MAX_DESK_MORE);
	return {
		tag,
		articles: [...shown, ...more],
		rows: layOutRows(shown),
		more,
		pattern,
		spotlightId
	};
}

/**
 * Smart editorial rows. Deterministic, content-only - never random:
 * - Pairs always split evenly [6,6]. A [7,5] image/text pair looks broken:
 *   the wide card's fixed-ratio thumb balloons into a giant hero while the
 *   text card squishes beside it. Equal pairs keep both cards level.
 * - Image-led stories still earn prominence: a lone visual against text-only
 *   trios/quads flows into the trio/quad, and full-width [12] singles.
 * - Text-only flows in clean trios [4,4,4], quads [3,3,3,3], or an even
 *   [6,6] tail. Singles go full-width [12].
 * Every row sums to 12 so left/right edges align perfectly; uniform card
 * heights (h-full, fixed thumb ratio) keep baselines level - no masonry.
 */
export function layOutRows(articles: ArticleRow[]): GridRow[] {
	const rows: GridRow[] = [];
	let i = 0;
	while (i < articles.length) {
		const remaining = articles.length - i;
		if (remaining === 1) {
			rows.push({ stories: [{ article: articles[i], span: 12 }] });
			i += 1;
		} else if (remaining === 4 && !articles.slice(i, i + 4).some((a) => a.imageUrl)) {
			rows.push({
				stories: articles.slice(i, i + 4).map((a) => ({ article: a, span: 3 as ColSpan }))
			});
			i += 4;
		} else if (remaining === 2 || remaining % 3 === 2) {
			// Pairs stay even - clean alignment beats clever asymmetry.
			rows.push({
				stories: [
					{ article: articles[i], span: 6 },
					{ article: articles[i + 1], span: 6 }
				]
			});
			i += 2;
		} else {
			rows.push({
				stories: articles.slice(i, i + 3).map((a) => ({ article: a, span: 4 as ColSpan }))
			});
			i += 3;
		}
	}
	return rows;
}

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

	// Stories carry several tags and are filed to their FIRST-ranked desk, so
	// a topic's bucket can end up smaller than its tag count (a higher-ranked
	// desk siphons the shared stories). Drop desks that receive fewer than
	// `minStories` - a lone story makes a giant one-card desk - then re-bucket
	// so orphaned stories land on their best remaining desk. Anything still
	// unclaimed falls through to Latest in buildMagazineSections.
	let candidates = ranked;
	let buckets = bucketByFirstRanked(candidates, articles);
	const filled = candidates.filter((r) => (buckets.get(r.tag.id)?.length ?? 0) >= minStories);
	if (filled.length !== candidates.length) {
		candidates = filled;
		if (candidates.length === 0) return [];
		buckets = bucketByFirstRanked(candidates, articles);
	}

	return candidates
		.map((r) => toDesk(r.tag, buckets.get(r.tag.id) ?? [], maxStories))
		.filter((d) => d.articles.length >= minStories);
}

/** Files every story to its first-ranked desk among `candidates`. */
function bucketByFirstRanked(
	candidates: { tag: TagRef }[],
	pool: ArticleRow[]
): Map<number, ArticleRow[]> {
	const buckets = new Map<number, ArticleRow[]>();
	for (const r of candidates) buckets.set(r.tag.id, []);
	for (const a of pool) {
		const desk = candidates.find((r) => a.tags.some((t) => t.id === r.tag.id));
		if (desk) buckets.get(desk.tag.id)?.push(a);
	}
	return buckets;
}

/**
 * Lays out the front page like an editor.
 *
 * The lead prefers an unread story with an image; the next two stories back
 * it up. Stories with no topic desk beat are split into Latest (shown before
 * the desks) and a short More headlines tail shown last; the remainder is
 * filed into topic desks from the AI tags. Filtering (Today, feed,
 * collection, search) scopes the whole edition.
 */
export function buildMagazineSections(articles: ArticleRow[]): MagazineSections {
	const empty: MagazineSections = {
		lead: null,
		secondary: [],
		latest: [],
		desks: [],
		rest: [],
		blocks: []
	};
	if (articles.length === 0) return empty;
	let leadIndex = articles.findIndex((a) => !a.isRead && a.imageUrl);
	if (leadIndex < 0) leadIndex = articles.findIndex((a) => !a.isRead);
	if (leadIndex < 0) leadIndex = 0;
	const lead = articles[leadIndex];
	const pool = [...articles.slice(0, leadIndex), ...articles.slice(leadIndex + 1)];
	const secondary = pool.slice(0, 2);
	const deskPool = pool.slice(secondary.length);
	const desks = buildTopicDesks(deskPool);
	// Every story filed to a desk (grid AND overflow tail) stays with its
	// topic - only truly untagged stories fall through to Latest/rest.
	const inDesk = new Set(desks.flatMap((d) => d.articles.map((a) => a.id)));
	const leftover = deskPool.filter((a) => !inDesk.has(a.id));
	const latest = leftover.slice(0, MAX_LATEST);
	const rest = leftover.slice(MAX_LATEST, MAX_LATEST + MAX_MORE);
	return { lead, secondary, latest, desks, rest, blocks: buildBlocks(desks, latest) };
}

/**
 * Builds the front-page rhythm: ONE latest bento grid, then each desk in rank
 * order. Dynamism lives inside the grids (per-story spans + per-desk
 * patterns), so headers never repeat. Pure function - deterministic.
 */
export function buildBlocks(desks: TopicDesk[], latest: ArticleRow[]): MagazineBlock[] {
	const blocks: MagazineBlock[] = [];
	if (latest.length > 0) blocks.push({ kind: 'latest', rows: layOutRows(latest) });
	for (const desk of desks) blocks.push({ kind: 'desk', desk });
	return blocks;
}
