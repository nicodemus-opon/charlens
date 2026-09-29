// Auto-labels: topics and tags are the SAME thing — one ordered list per
// article, written both to article_tag rows (user-visible, magazine desks)
// and to article_embedding.topics (affinity, interest model).
//
// Order is the ranking: closed-taxonomy buckets lead because they summarise
// the article ("ai infrastructure"), body-specific tags fill the remaining
// budget ("nvidia", "menengai geothermal"). Near-duplicates collapse so
// "energy & power" never coexists with "power".
//
// Dependency-free so tsx scripts (retopic, clean-tags) share the exact merge
// rule with the live enrich path.

export interface LabelInputs {
	/** Closed-taxonomy buckets (topics.ts), most summarising first. */
	topics: string[];
	/** Body-specific extractive tags (keywords.ts / tag-rank.ts). */
	tags: string[];
	/** Capitalized entities; lowercased before merging. */
	entities: string[];
}

/** Total user-visible auto-labels per article. */
export const AUTO_LABEL_BUDGET = 5;
/** Taxonomy buckets lead but never crowd out specifics entirely. */
export const MAX_TAXONOMY_LABELS = 2;

function singularize(word: string): string {
	if (word.length <= 3) return word;
	if (word.endsWith('ies') && word.length > 5) return word.slice(0, -3) + 'y';
	if (/(ses|xes|zes|ches|shes)$/.test(word) && word.length > 5) return word.slice(0, -2);
	if (word.endsWith('s') && !/(ss|us)$/.test(word)) return word.slice(0, -1);
	return word;
}

function bagKey(s: string): string {
	return s
		.split(' ')
		.map((w) => singularize(w))
		.filter((w) => w.length >= 2)
		.sort()
		.join(' ');
}

function covers(list: string[], w: string): boolean {
	return list.some((t) => {
		if (t === w || t.includes(w) || w.includes(t)) return true;
		return bagKey(t) === bagKey(w);
	});
}

function clean(s: string): string {
	return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Merge taxonomy buckets + specific tags + entities into one deduped,
 * budgeted label set. Pure and total: never throws, [] when unsure.
 */
export function buildLabelSet(input: LabelInputs, budget = AUTO_LABEL_BUDGET): string[] {
	const labels: string[] = [];
	const push = (raw: string) => {
		const w = clean(raw);
		if (!w || w.length > 60) return;
		if (labels.length >= budget) return;
		if (!covers(labels, w)) labels.push(w);
	};
	for (const t of input.topics.slice(0, MAX_TAXONOMY_LABELS)) push(t);
	for (const t of input.tags) push(t);
	for (const e of input.entities) push(e);
	return labels.slice(0, Math.max(0, budget));
}
