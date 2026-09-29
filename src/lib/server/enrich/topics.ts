// Closed-vocabulary topic classifier: maps varied article wording onto one
// canonical bucket ("GPU data-center buildout" + "NVIDIA AI chips" both land
// on "ai infrastructure") instead of echoing title words.
//
// Two paths, same taxonomy:
// - Semantic (primary): cosine between the article embedding and one probe
//   vector per topic (label + description + exemplars), using the already
//   cached MiniLM model via embedTexts. No new downloads, no network.
// - Keyword fallback (sync, no model): alias/hint overlap against the full
//   title + body text. Body-centric on purpose — title words are a bonus,
//   never a gate (the title-gating in keywords.ts was the root cause of
//   "tags are just title words").
//
// Topics are deliberately coarse (max 2 per article). Specificity lives in
// tags/entities; topics exist for desks, affinity and interest histograms.

import { cosineSimilarity } from '$lib/server/recommend/score';

// Default embedder, lazy-imported so this module stays dependency-free at
// load time (tsx scripts like scripts/retopic.ts can import the keyword
// fallback without the $env-backed embeddings runtime; the dynamic import
// failure then just routes to the keyword path via the caller's try/catch).
async function defaultEmbed(texts: string[]): Promise<(number[] | null)[]> {
	const m = await import('./embeddings');
	return m.embedTexts(texts);
}

export interface TopicDef {
	/** Stable slug, also the stored value in article_embedding.topics. */
	id: string;
	/** Human label. Lowercase by convention (matches tag normalization). */
	label: string;
	/** One-line scope so the probe embedding carries meaning. */
	description: string;
	/** Alias phrases for the keyword fallback path. */
	hints: string[];
}

/** Curated closed set. Extend by appending; backfill re-maps old articles. */
export const TOPIC_TAXONOMY: TopicDef[] = [
	{
		id: 'ai-ml',
		label: 'ai & machine learning',
		description: 'Artificial intelligence research, machine learning models and AI applications',
		hints: [
			'artificial intelligence',
			'machine learning',
			'ai model',
			'llm',
			'large language model',
			'generative ai',
			'chatbot',
			'deep learning',
			'neural network'
		]
	},
	{
		id: 'ai-infrastructure',
		label: 'ai infrastructure',
		description: 'AI chips, GPUs, data centers and compute capacity for AI workloads',
		hints: [
			'ai infrastructure',
			'data center',
			'gpu',
			'ai chip',
			'compute capacity',
			'nvidia',
			'hyperscaler'
		]
	},
	{
		id: 'semiconductors',
		label: 'semiconductors',
		description: 'Chips, fabs, semiconductor supply chain and export controls',
		hints: ['semiconductor', 'chip', 'fab', 'foundry', 'tsmc', 'asml', 'export control', 'silicon']
	},
	{
		id: 'software-dev',
		label: 'software development',
		description: 'Programming, developer tools, open source and software engineering practices',
		hints: [
			'software',
			'developer',
			'programming',
			'coding',
			'open source',
			'github',
			'api',
			'framework',
			'devops'
		]
	},
	{
		id: 'cybersecurity',
		label: 'cybersecurity',
		description: 'Hacks, breaches, ransomware, vulnerabilities and digital security',
		hints: [
			'cybersecurity',
			'hack',
			'breach',
			'ransomware',
			'malware',
			'vulnerability',
			'phishing',
			'zero-day'
		]
	},
	{
		id: 'consumer-tech',
		label: 'consumer tech',
		description: 'Smartphones, gadgets, apps and consumer electronics',
		hints: [
			'smartphone',
			'iphone',
			'android',
			'gadget',
			'app store',
			'wearable',
			'laptop',
			'consumer electronics'
		]
	},
	{
		id: 'startups-venture',
		label: 'startups & venture',
		description: 'Startups, venture capital funding rounds and entrepreneurship',
		hints: [
			'startup',
			'venture capital',
			'funding round',
			'series a',
			'unicorn',
			'founder',
			'seed funding'
		]
	},
	{
		id: 'climate-environment',
		label: 'climate & environment',
		description: 'Climate change, emissions, conservation and environmental policy',
		hints: [
			'climate',
			'emission',
			'carbon',
			'global warming',
			'conservation',
			'cop28',
			'deforestation',
			'pollution'
		]
	},
	{
		id: 'energy-power',
		label: 'energy & power',
		description: 'Electricity grids, geothermal, renewables, oil and gas, power generation',
		hints: [
			'geothermal',
			'power grid',
			'electricity',
			'renewable',
			'solar',
			'wind farm',
			'oil and gas',
			'power plant',
			'megawatt',
			'grid operator'
		]
	},
	{
		id: 'space',
		label: 'space & satellites',
		description: 'Rockets, satellites, space agencies and orbital launches',
		hints: ['spacex', 'satellite', 'rocket', 'nasa', 'orbit', 'starlink', 'space agency', 'launch']
	},
	{
		id: 'health-medicine',
		label: 'health & medicine',
		description: 'Public health, disease, drugs, hospitals and medical research',
		hints: [
			'vaccine',
			'hospital',
			'disease',
			'outbreak',
			'clinical trial',
			'drug',
			'public health',
			'who'
		]
	},
	{
		id: 'markets-investing',
		label: 'markets & investing',
		description: 'Stock markets, investors, asset prices and corporate earnings',
		hints: [
			'stock market',
			'investor',
			'shares',
			'earnings',
			'nasdaq',
			'wall street',
			'ipo',
			'bond yield'
		]
	},
	{
		id: 'monetary-policy',
		label: 'monetary policy',
		description: 'Central banks, interest rates, inflation and monetary decisions',
		hints: [
			'interest rate',
			'central bank',
			'inflation',
			'federal reserve',
			'ecb',
			'rate cut',
			'rate hike',
			'monetary'
		]
	},
	{
		id: 'trade-tariffs',
		label: 'trade & tariffs',
		description: 'International trade, tariffs, supply chains and export policy',
		hints: ['tariff', 'trade war', 'supply chain', 'export', 'import duty', 'trade deal', 'wto']
	},
	{
		id: 'jobs-labor',
		label: 'jobs & labor',
		description: 'Employment, wages, layoffs, unions and labor markets',
		hints: ['layoff', 'unemployment', 'wages', 'union', 'hiring', 'job market', 'strike', 'payroll']
	},
	{
		id: 'us-politics',
		label: 'us politics',
		description: 'US federal government, congress, white house and domestic policy',
		hints: ['white house', 'congress', 'senate', 'biden', 'trump', 'supreme court', 'capitol']
	},
	{
		id: 'geopolitics-defence',
		label: 'geopolitics & defence',
		description: 'Wars, military action, alliances and international security',
		hints: [
			'military',
			'nato',
			'invasion',
			'ceasefire',
			'defense',
			'airstrike',
			'troops',
			'war in ukraine'
		]
	},
	{
		id: 'elections-democracy',
		label: 'elections & democracy',
		description: 'Elections, voting, campaigns and democratic institutions',
		hints: ['election', 'vote', 'ballot', 'campaign', 'polls', 'referendum', 'voter turnout']
	},
	{
		id: 'regulation-antitrust',
		label: 'regulation & antitrust',
		description: 'Government regulation, antitrust cases, fines and compliance',
		hints: ['antitrust', 'regulator', 'fine', 'lawsuit', 'compliance', 'dma', 'ftc', 'court ruling']
	},
	{
		id: 'kenya-politics',
		label: 'kenya politics',
		description: 'Kenyan government, parliament, counties and domestic policy',
		hints: [
			'ruto',
			'parliament',
			'nairobi',
			'county government',
			'state house',
			'kenyan mps',
			'odinga'
		]
	},
	{
		id: 'kenya-energy-infra',
		label: 'kenya energy & infrastructure',
		description: 'Kenyan power projects, geothermal plants, roads and infrastructure builds',
		hints: [
			'menengai',
			'kengen',
			'kenya power',
			'kplc',
			'geothermal',
			'expressway',
			'ketraco',
			'rural electrification'
		]
	},
	{
		id: 'africa',
		label: 'africa',
		description: 'African continental news, AU, regional politics and development',
		hints: ['african union', 'africa', 'ecowas', 'sadc', 'east africa', 'au summit']
	},
	{
		id: 'china',
		label: 'china',
		description: 'Chinese economy, politics, technology and foreign relations',
		hints: [
			'beijing',
			'xi jinping',
			'chinese economy',
			'ccp',
			'shanghai',
			'taiwan strait',
			'huawei'
		]
	},
	{
		id: 'europe',
		label: 'europe',
		description: 'European Union, eurozone economies and European politics',
		hints: [
			'european union',
			'brussels',
			'eurozone',
			'eu leaders',
			'european parliament',
			'berlin',
			'paris'
		]
	},
	{
		id: 'middle-east',
		label: 'middle east',
		description: 'Middle East conflicts, Gulf states, oil politics and diplomacy',
		hints: ['gaza', 'israel', 'saudi', 'iran', 'uae', 'hezbollah', 'red sea', 'opec']
	},
	{
		id: 'sports',
		label: 'sports',
		description: 'Football, athletics, olympics and sporting competitions',
		hints: [
			'premier league',
			'champions league',
			'olympics',
			'marathon',
			'fifa',
			'championship',
			'athletics'
		]
	},
	{
		id: 'entertainment-culture',
		label: 'entertainment & culture',
		description: 'Film, music, streaming, celebrities and cultural events',
		hints: [
			'netflix',
			'box office',
			'album',
			'concert',
			'hollywood',
			'streaming',
			'grammy',
			'festival'
		]
	},
	{
		id: 'media-journalism',
		label: 'media & journalism',
		description: 'News industry, press freedom, social platforms and misinformation',
		hints: [
			'journalist',
			'press freedom',
			'newsroom',
			'misinformation',
			'social media',
			'x platform',
			'tiktok',
			'meta'
		]
	},
	{
		id: 'education-research',
		label: 'education & research',
		description: 'Schools, universities, exams, academic research and student policy',
		hints: [
			'university',
			'school',
			'exam',
			'kcse',
			'cbc',
			'research paper',
			'scholarship',
			'teachers'
		]
	},
	{
		id: 'food-agriculture',
		label: 'food & agriculture',
		description: 'Farming, crops, food prices, livestock and agricultural policy',
		hints: [
			'maize',
			'tea farming',
			'coffee',
			'horticulture',
			'fertilizer',
			'food price',
			'harvest',
			'livestock'
		]
	},
	{
		id: 'transport-mobility',
		label: 'transport & mobility',
		description: 'Aviation, rail, shipping, electric vehicles and urban transit',
		hints: [
			'airline',
			'railway',
			'sgr',
			'electric vehicle',
			'matatu',
			'shipping',
			'airport',
			'port'
		]
	},
	{
		id: 'housing-realestate',
		label: 'housing & real estate',
		description: 'Housing markets, rents, mortgages and property development',
		hints: [
			'housing',
			'rent',
			'mortgage',
			'property',
			'real estate',
			'affordable housing',
			'landlord'
		]
	}
];

/** Below this cosine the topic does not describe the article. */
export const MIN_TOPIC_SIM = 0.3;
/** Default cap: topics stay coarse, specificity lives in tags. */
export const MAX_TOPICS = 2;

export function topicProbeText(t: TopicDef): string {
	return `${t.label}. ${t.description}. ${t.hints.slice(0, 6).join(', ')}`;
}

/**
 * Pure vector rerank: score one article vector against precomputed topic
 * vectors, return top labels above threshold. All model I/O stays outside
 * so this is trivially unit-testable.
 */
export function classifyByVectors(
	articleVec: number[] | null,
	topicVecs: Map<string, number[]>,
	limit = MAX_TOPICS,
	minSim = MIN_TOPIC_SIM
): string[] {
	if (!articleVec) return [];
	const scored: { label: string; sim: number }[] = [];
	for (const [label, vec] of topicVecs) {
		const sim = cosineSimilarity(articleVec, vec);
		if (sim >= minSim) scored.push({ label, sim });
	}
	return scored
		.sort((a, b) => b.sim - a.sim)
		.slice(0, Math.max(0, limit))
		.map((s) => s.label);
}

function norm(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ');
}

/**
 * Sync keyword fallback (no model): hint-phrase overlap against the FULL
 * title + body text. Title matches score a bonus point each, but body-only
 * evidence alone is enough — this is what makes topics summarise instead
 * of echoing the headline.
 *
 * Scoring is structural, not per-hint tuned: multi-word hints outscore
 * single words (a bare word like "trade" matching once proves little),
 * converging evidence earns a corroboration bonus (two distinct hits prove
 * more than one repeated hit), and very short texts need two distinct hits
 * (one-word evidence on a one-liner is how "space & satellites" lands on a
 * screen-recorder repo).
 */
export function classifyKeywordTopics(
	title: string | null | undefined,
	text: string | null | undefined,
	limit = MAX_TOPICS
): string[] {
	const hay = norm(`${title ?? ''} ${text ?? ''}`.slice(0, 6000));
	if (hay.replace(/[^a-z]/g, '').length < 20) return [];
	const shortText = hay.replace(/[^a-z]/g, '').length < 300;
	const titleNorm = norm(title ?? '');
	const scored: { label: string; score: number }[] = [];
	for (const t of TOPIC_TAXONOMY) {
		let score = 0;
		let distinct = 0;
		const seen = new Set<string>();
		for (const rawHint of t.hints) {
			const hint = norm(rawHint).trim();
			if (!hint || seen.has(hint)) continue;
			seen.add(hint);
			if (hint.includes(' ')) {
				if (hay.includes(hint)) {
					score += 3 + (titleNorm.includes(hint) ? 1 : 0);
					distinct += 1;
				}
			} else if (hint.length >= 3) {
				const re = new RegExp(`\\b${hint.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`);
				if (re.test(hay)) {
					score += 1 + (re.test(titleNorm) ? 1 : 0);
					distinct += 1;
				}
			}
		}
		// Corroboration bonus: two distinct hints firing beats one hint
		// repeated. Decided before the threshold so "menengai + geothermal"
		// (two weak singles) still summarises a one-liner.
		if (distinct >= 2) score += 1;
		if (score >= 3 && (!shortText || distinct >= 2)) scored.push({ label: t.label, score });
	}
	return scored
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(0, limit))
		.map((s) => s.label);
}

// Cached probe vectors: one batch embed per process, then pure cosine.
let probeCache: { key: string; vecs: Map<string, number[]> } | null = null;

function probeCacheKey(model: string): string {
	return `${model}::v1::${TOPIC_TAXONOMY.length}`;
}

/** Test-only: drop the cached probe vectors. */
export function _resetTopicsForTests(): void {
	probeCache = null;
}

async function getTopicVectors(
	embed: (texts: string[]) => Promise<(number[] | null)[]>,
	model: string
): Promise<Map<string, number[]> | null> {
	const key = probeCacheKey(model);
	if (probeCache?.key === key) return probeCache.vecs;
	const probes = TOPIC_TAXONOMY.map(topicProbeText);
	const vecs = await embed(probes);
	const out = new Map<string, number[]>();
	TOPIC_TAXONOMY.forEach((t, i) => {
		const v = vecs[i];
		if (v) out.set(t.label, v);
	});
	if (out.size === 0) return null;
	probeCache = { key, vecs: out };
	return out;
}

export interface TopicDoc {
	title?: string | null;
	text?: string | null;
	/** Reuse the article embedding computed in enrich (avoids a 2nd call). */
	vector?: number[] | null;
}

/**
 * Classify one article: semantic cosine when vectors exist, keyword
 * fallback otherwise. Never throws, never returns junk — [] when unsure.
 */
export async function classifyArticleTopics(
	doc: TopicDoc,
	limit = MAX_TOPICS,
	embed: (texts: string[]) => Promise<(number[] | null)[]> = defaultEmbed,
	model = 'all-MiniLM-L6-v2'
): Promise<string[]> {
	const vec = doc.vector ?? null;
	if (vec) {
		try {
			const topicVecs = await getTopicVectors(embed, model);
			if (topicVecs) {
				const out = classifyByVectors(vec, topicVecs, limit);
				if (out.length > 0) return out;
			}
		} catch {
			// fall through to keyword path
		}
	}
	return classifyKeywordTopics(doc.title, doc.text, limit);
}
