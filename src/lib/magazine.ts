import type { ArticleRow } from '$lib/article.js';
import type { TagRef } from '$lib/tags.js';

/** Visual weight of a story, derived from its content signals. */
export type StoryEmphasis = 'visual' | 'featured' | 'standard' | 'brief';

/**
 * Nested layout pattern for a topic desk. Chosen from the desk's own
 * content — never at random — so each desk reads differently:
 * - `spotlight`: one image-led story features large (8+4 lead row), the rest flow below.
 * - `symmetric`: a balanced grid (stories are visually even, rhythm staggered per desk).
 * - `headlines`: text-led stack for desks with no usable imagery.
 */
export type DeskPattern = 'spotlight' | 'symmetric' | 'headlines';

/** Hero shape at the top of the front page, picked from image signals. */
export type HeroVariant = 'cover' | 'split' | 'trio';

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
 * exist (see `spanClass` in magazine-view): 12, 8, 6, 4, 3.
 * Every row sums to exactly 12, so edges always align - never jagged.
 * Asymmetry comes from 8+4 (feature + companion) and 6+3+3 (lead + two
 * briefs). Pairs default to an even 6+6 unless one story clearly
 * outscores the other; the wide card then renders horizontally so its
 * fixed-ratio thumb never balloons beside a squished card.
 */
export type ColSpan = 12 | 8 | 6 | 4 | 3;

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
	/** Hero shape derived from lead + secondary image signals. */
	hero: HeroVariant;
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

/**
 * Picks the hero shape from image signals only — deterministic:
 * - `trio`: lead + both secondaries carry images (three-up hero row).
 * - `split`: lead + one secondary carry images (asymmetric 8/4 hero).
 * - `cover`: anything else (full-width horizontal feature + even pair below).
 */
export function pickHeroVariant(lead: ArticleRow, secondary: ArticleRow[]): HeroVariant {
	const visuals = [lead, ...secondary].filter((a) => a.imageUrl).length;
	if (secondary.length >= 2 && visuals >= 3) return 'trio';
	if (lead.imageUrl && visuals >= 2) return 'split';
	return 'cover';
}

function toDesk(tag: TagRef, articles: ArticleRow[], gridSize: number, offset: number): TopicDesk {
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
		rows: layOutRows(shown, { offset }),
		more,
		pattern,
		spotlightId
	};
}

/**
 * Smart editorial rows. Deterministic, content-only - never random:
 * - A clearly stronger visual/featured story earns asymmetry: 8+4 over a
 *   weaker companion, or 6+3+3 leading two briefs.
 * - Even pairs stay 6+6; even trios stay 4+4+4; all-brief quads go 3x4.
 * - Singles go full-width 12.
 * Every row sums to 12 so left/right edges align perfectly; the view
 * renders 8-spans horizontally so wide thumbs never balloon. `offset`
 * (desk index) staggers the default trio/pair choice so adjacent even
 * desks don't open with the same shape.
 */
export function layOutRows(articles: ArticleRow[], opts: { offset?: number } = {}): GridRow[] {
	const rows: GridRow[] = [];
	const offset = opts.offset ?? 0;
	let i = 0;
	while (i < articles.length) {
		const remaining = articles.length - i;
		const slice4 = articles.slice(i, i + 4);
		if (remaining === 1) {
			rows.push({ stories: [{ article: articles[i], span: 12 }] });
			i += 1;
			continue;
		}
		if (remaining === 4 && !slice4.some((a) => a.imageUrl)) {
			rows.push({
				stories: slice4.map((a) => ({ article: a, span: 3 as ColSpan }))
			});
			i += 4;
			continue;
		}
		if (remaining >= 3) {
			const [a, b, c] = [articles[i], articles[i + 1], articles[i + 2]];
			const leader = scoreStory(a) - Math.max(scoreStory(b), scoreStory(c));
			const briefs = [b, c].filter((s) => getStoryEmphasis(s) === 'brief').length;
			if (a.imageUrl && leader >= 3 && briefs >= 1) {
				rows.push({
					stories: [
						{ article: a, span: 6 },
						{ article: b, span: 3 as ColSpan },
						{ article: c, span: 3 as ColSpan }
					]
				});
				i += 3;
				continue;
			}
		}
		if (remaining >= 2) {
			const [a, b] = [articles[i], articles[i + 1]];
			const gap = scoreStory(a) - scoreStory(b);
			const strongLead =
				(a.imageUrl || getStoryEmphasis(a) === 'featured') &&
				getStoryEmphasis(b) !== 'visual' &&
				getStoryEmphasis(b) !== 'featured' &&
				gap >= 2;
			if (strongLead) {
				// Wide card renders horizontally in the view, so the thumb
				// stays level instead of ballooning beside the narrow card.
				rows.push({
					stories: [
						{ article: a, span: 8 as ColSpan },
						{ article: b, span: 4 }
					]
				});
				i += 2;
				continue;
			}
		}
		if (remaining === 4 && (rows.length + offset) % 2 === 0) {
			// Stagger even desks: open 8+4 instead of 6+6 so neighbours differ.
			const [a, b] = [articles[i], articles[i + 1]];
			if (a.imageUrl || b.imageUrl) {
				rows.push({
					stories: [
						{ article: a, span: 8 as ColSpan },
						{ article: b, span: 4 }
					]
				});
				i += 2;
				continue;
			}
		}
		if (remaining === 2 || remaining % 3 === 2) {
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
		.map((r, index) => toDesk(r.tag, buckets.get(r.tag.id) ?? [], maxStories, index))
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
		hero: 'cover',
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
	return {
		lead,
		secondary,
		hero: pickHeroVariant(lead, secondary),
		latest,
		desks,
		rest,
		blocks: buildBlocks(desks, latest)
	};
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
