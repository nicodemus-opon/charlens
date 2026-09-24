import { env } from '$env/dynamic/private';

// Local embedding runtime (Transformers.js, all-MiniLM-L6-v2, 384-dim).
//
// - Lazy singleton: the ~80MB ONNX model downloads once into EMBED_CACHE_DIR
//   (persisted via a Docker volume) and stays resident for the process.
// - Every failure mode degrades to null so keyword tagging + refresh never
//   break when the model is missing, slow, or unsupported on the platform.
// - Vectors are L2-normalized at write time, so cosine similarity is a dot
//   product (see score.cosineSimilarity).

export const EMBED_DIM = 384;

let enabledOverride: boolean | null = null;

/** Test-only: force embeddings on/off without touching process env. */
export function _setEmbeddingsEnabledForTests(value: boolean | null): void {
	enabledOverride = value;
}

export function isEmbeddingsEnabled(): boolean {
	if (enabledOverride !== null) return enabledOverride;
	return (env.EMBED_ENABLED ?? '1') !== '0';
}

export function getEmbedModel(): string {
	return env.EMBED_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
}

export function getEmbedBatchSize(): number {
	const n = Number(env.EMBED_BATCH ?? 16);
	if (!Number.isFinite(n)) return 16;
	return Math.min(64, Math.max(1, Math.floor(n)));
}

type FeaturePipeline = (
	text: string | string[],
	opts?: { pooling?: string; normalize?: boolean }
) => Promise<{
	tolist: () => number[] | number[][];
}>;

let pipelinePromise: Promise<FeaturePipeline | null> | null = null;
let loadFailedAt = 0;
const LOAD_RETRY_MS = 5 * 60 * 1000;

async function loadPipeline(): Promise<FeaturePipeline | null> {
	if (!isEmbeddingsEnabled()) return null;
	const now = Date.now();
	if (loadFailedAt > 0 && now - loadFailedAt < LOAD_RETRY_MS) return null;
	if (!pipelinePromise) {
		pipelinePromise = (async () => {
			try {
				if (env.EMBED_CACHE_DIR) {
					// Point the HuggingFace cache at the persistent volume.
					process.env.TRANSFORMERS_CACHE = env.EMBED_CACHE_DIR;
					process.env.HF_HOME = env.EMBED_CACHE_DIR;
				}
				const { pipeline } = await import('@xenova/transformers');
				const pipe = (await pipeline('feature-extraction', getEmbedModel(), {
					quantized: true
				})) as unknown as FeaturePipeline;
				return pipe;
			} catch (e) {
				console.error('embeddings model failed to load (keyword-only mode)', e);
				loadFailedAt = Date.now();
				pipelinePromise = null;
				return null;
			}
		})();
	}
	return pipelinePromise;
}

/** Embed one text. Returns a normalized 384-dim vector or null. */
export async function embedText(text: string): Promise<number[] | null> {
	const out = await embedTexts([text]);
	return out[0] ?? null;
}

/** Embed a batch. Null entries mark per-text failures (never throws). */
export async function embedTexts(texts: string[]): Promise<(number[] | null)[]> {
	const pipe = await loadPipeline();
	if (!pipe) return texts.map(() => null);
	const clean = texts.map((t) => t.slice(0, 2000).trim()).map((t) => (t ? t : 'empty'));
	try {
		const batch = getEmbedBatchSize();
		const out: (number[] | null)[] = [];
		for (let i = 0; i < clean.length; i += batch) {
			const chunk = clean.slice(i, i + batch);
			const tensor = await pipe(chunk.length === 1 ? chunk[0] : chunk, {
				pooling: 'mean',
				normalize: true
			});
			const rows = tensor.tolist() as number[] | number[][];
			const list: number[][] = Array.isArray(rows[0]) ? (rows as number[][]) : [rows as number[]];
			for (const vec of list) {
				out.push(vec.length === EMBED_DIM ? vec : null);
			}
		}
		return out;
	} catch (e) {
		console.error('embeddings inference failed', e);
		return texts.map(() => null);
	}
}

/** Test-only: drop the cached pipeline so tests can stub the model. */
export function _resetEmbeddingsForTests(): void {
	pipelinePromise = null;
	loadFailedAt = 0;
	enabledOverride = null;
}
