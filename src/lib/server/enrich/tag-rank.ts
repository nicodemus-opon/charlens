import { env } from '$env/dynamic/private';
import { embedTexts } from './embeddings';
import { cosineSimilarity } from '$lib/server/recommend/score';

// KeyBERT-style tag reranker on top of the existing MiniLM embeddings.
//
// The v5 heuristic extractor (keywords.ts) stays as the CANDIDATE GENERATOR;
// this module is the semantic filter/ranker that decides which candidates
// actually describe the article:
//
// - embed the document (title + lead) and every candidate once
// - relevance = cosine(candidate, document) + title boost
// - drop candidates below MIN_SIM (off-topic scraper chrome that happens to
//   repeat: "secure payments kenya", "flash sale" survivors, etc.)
// - MMR diversification so 5 near-duplicate tags never fill the budget
//
// Degrades to the plain heuristic order whenever embeddings are disabled or
// the model is unavailable — same philosophy as embeddings.ts.

export interface RankDoc {
	title?: string | null;
	text?: string | null;
}

export type EmbedBatch = (texts: string[]) => Promise<(number[] | null)[]>;

export function isTagRankEnabled(): boolean {
	return (env.TAG_RANK_ENABLED ?? '1') !== '0';
}

/** Below this cosine the candidate does not describe the document. */
export const MIN_SIM = 0.25;
/** Title-anchored candidates get a small edge (mirrors the v3 anchoring). */
const TITLE_BOOST = 0.1;
/** MMR trade-off: 0.7 relevance / 0.3 diversity. */
const MMR_LAMBDA = 0.7;

function dedupe(candidates: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const c of candidates) {
		const key = c.trim().toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(key);
	}
	return out;
}

function titleAnchored(candidate: string, titleTokens: Set<string>): boolean {
	if (titleTokens.size === 0) return false;
	return candidate.split(' ').every((w) => titleTokens.has(w));
}

/**
 * Rank and filter candidate tags for a document. `candidates` should come
 * from extractTopics() (entity-first order is the tie-break fallback).
 * Pass a custom `embed` in tests; production uses the shared MiniLM pipeline.
 */
export async function rankTags(
	candidates: string[],
	doc: RankDoc,
	limit = 5,
	embed: EmbedBatch = embedTexts
): Promise<string[]> {
	const uniq = dedupe(candidates);
	if (uniq.length === 0) return [];
	if (!isTagRankEnabled()) return uniq.slice(0, limit);

	const title = doc.title ?? '';
	const docText = `${title}. ${(doc.text ?? '').slice(0, 800)}`.trim();
	if (!docText) return uniq.slice(0, limit);

	const vectors = await embed([docText, ...uniq]);
	const docVec = vectors[0];
	if (!docVec) return uniq.slice(0, limit); // model unavailable: heuristic order

	const titleTokens = new Set(
		title
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, ' ')
			.split(/[\s-]+/)
			.filter((t) => t.length >= 2)
	);

	// Relevance per candidate; candidates whose own embedding failed keep a
	// neutral 0 so they can still surface via MMR if everything else is worse.
	const rel: number[] = uniq.map((c, i) => {
		const v = vectors[i + 1];
		const sim = v ? cosineSimilarity(v, docVec) : 0;
		return sim + (titleAnchored(c, titleTokens) ? TITLE_BOOST : 0);
	});

	// Greedy MMR: pick the most relevant, then repeatedly the candidate that
	// is relevant AND least similar to what is already selected.
	const selected: number[] = [];
	const remaining = new Set(uniq.map((_, i) => i));
	while (remaining.size > 0 && selected.length < limit) {
		let best = -1;
		let bestScore = -Infinity;
		for (const i of remaining) {
			let redundancy = 0;
			for (const s of selected) {
				const a = vectors[i + 1];
				const b = vectors[s + 1];
				if (a && b) redundancy = Math.max(redundancy, cosineSimilarity(a, b));
			}
			const score = MMR_LAMBDA * rel[i] - (1 - MMR_LAMBDA) * redundancy;
			if (score > bestScore) {
				bestScore = score;
				best = i;
			}
		}
		// Nothing left that actually describes the document — stop early
		// instead of padding the tag budget with off-topic candidates.
		if (best < 0 || rel[best] < MIN_SIM) break;
		selected.push(best);
		remaining.delete(best);
	}

	if (selected.length === 0) {
		// Every candidate fell below MIN_SIM: the heuristic list was junk.
		// Better zero semantic tags than five bad ones (feed <category> tags
		// still stand alone, same as the CJK early-exit in keywords.ts).
		return [];
	}
	return selected.map((i) => uniq[i]);
}
