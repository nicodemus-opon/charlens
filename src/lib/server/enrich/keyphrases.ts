import { env } from '$env/dynamic/private';

// Phase 2: purpose-built keyphrase extraction model (token-classification
// ONNX via Transformers.js), OFF by default — Phase 1 (tag-rank.ts) must
// prove insufficient first.
//
// - Enable with TAG_MODEL_ENABLED=1; TAG_MODEL_NAME overrides the model id.
// - Default: ml6team/keyphrase-extraction-distilbert-inspec (~250MB, MIT,
//   trained on Inspec keyphrases, English). That repo ships PyTorch weights
//   only — convert once and point TAG_MODEL_NAME at the converted repo/dir:
//     scripts/convert-keyphrase-model.sh
// - Lazy singleton, ~5min retry backoff after a load failure, and every
//   failure mode degrades to [] so Phase 1 ranking keeps working.
// - Reuses EMBED_CACHE_DIR for the HuggingFace cache (same Docker volume as
//   the embedding model).

export function isKeyphraseModelEnabled(): boolean {
	return (env.TAG_MODEL_ENABLED ?? '0') === '1';
}

const PYTORCH_ONLY_DEFAULT = 'ml6team/keyphrase-extraction-distilbert-inspec';

/** True when TAG_MODEL_NAME still points at the PyTorch-only upstream repo. */
export function isDefaultUnconvertedModel(): boolean {
	return getTagModelName().trim() === PYTORCH_ONLY_DEFAULT;
}

export function getTagModelName(): string {
	return env.TAG_MODEL_NAME ?? 'ml6team/keyphrase-extraction-distilbert-inspec';
}

export interface KeyphraseToken {
	entity: string;
	word: string;
	score: number;
}

type TokenPipeline = (text: string) => Promise<KeyphraseToken[]>;

let pipelinePromise: Promise<TokenPipeline | null> | null = null;
let loadFailedAt = 0;
const LOAD_RETRY_MS = 5 * 60 * 1000;

async function loadPipeline(): Promise<TokenPipeline | null> {
	if (!isKeyphraseModelEnabled()) return null;
	// The default model id ships PyTorch weights only — Transformers.js can
	// never load it (missing onnx/model_quantized.onnx). Skip the download
	// attempt entirely so deploys without a converted repo stay on quiet
	// phase-1 ranking instead of logging a stack trace every process boot.
	if (isDefaultUnconvertedModel()) return null;
	const now = Date.now();
	if (loadFailedAt > 0 && now - loadFailedAt < LOAD_RETRY_MS) return null;
	if (!pipelinePromise) {
		pipelinePromise = (async () => {
			try {
				if (env.EMBED_CACHE_DIR) {
					process.env.TRANSFORMERS_CACHE = env.EMBED_CACHE_DIR;
					process.env.HF_HOME = env.EMBED_CACHE_DIR;
				}
				const { pipeline } = await import('@xenova/transformers');
				const pipe = (await pipeline('token-classification', getTagModelName(), {
					quantized: true
				})) as unknown as TokenPipeline;
				return pipe;
			} catch (e) {
				console.error('keyphrase model failed to load (phase-1 ranking only)', e);
				loadFailedAt = Date.now();
				pipelinePromise = null;
				return null;
			}
		})();
	}
	return pipelinePromise;
}

/**
 * Group B-KEYPHRASE/I-KEYPHRASE token-classifier output into phrases.
 * '##' subword continuations rejoin their stem ("token", "##ization").
 * Pure + exported for tests.
 */
export function groupKeyphrases(tokens: KeyphraseToken[]): { phrase: string; score: number }[] {
	const out: { phrase: string; score: number }[] = [];
	let words: string[] = [];
	let scores: number[] = [];
	const flush = () => {
		const phrase = words.join(' ').trim();
		if (phrase && scores.length > 0) {
			const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
			out.push({ phrase, score: mean });
		}
		words = [];
		scores = [];
	};
	for (const t of tokens) {
		const label = t.entity.toUpperCase();
		const word = t.word.replace(/\s+/g, '');
		if (!word || word === '[CLS]' || word === '[SEP]') continue;
		if (label.startsWith('B')) {
			flush();
			words.push(word.replace(/^##/, ''));
			scores.push(t.score);
		} else if (label.startsWith('I') && words.length > 0) {
			if (word.startsWith('##')) words[words.length - 1] += word.slice(2);
			else words.push(word);
			scores.push(t.score);
		} else {
			flush(); // 'O' (or stray I- with no open phrase) ends the phrase
		}
	}
	flush();
	return out;
}

/**
 * Extract open-vocabulary keyphrases from article text. Returns [] when the
 * model is disabled/unavailable so callers fall back to heuristic candidates.
 */
export async function extractKeyphrases(text: string, limit = 10): Promise<string[]> {
	const pipe = await loadPipeline();
	if (!pipe) return [];
	try {
		const tokens = await pipe(text.slice(0, 2000));
		const seen = new Set<string>();
		return groupKeyphrases(tokens)
			.map((g) => ({ ...g, phrase: g.phrase.toLowerCase() }))
			.filter((g) => {
				if (g.phrase.length < 3 || g.phrase.length > 40) return false;
				if (g.phrase.split(' ').length > 4) return false;
				if (seen.has(g.phrase)) return false;
				seen.add(g.phrase);
				return true;
			})
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((g) => g.phrase);
	} catch (e) {
		console.error('keyphrase inference failed', e);
		return [];
	}
}

/** Test-only: drop the cached pipeline so tests can stub the model. */
export function _resetKeyphrasesForTests(): void {
	pipelinePromise = null;
	loadFailedAt = 0;
}
