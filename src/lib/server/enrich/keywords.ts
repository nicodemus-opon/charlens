// Local-only keyword/topic/entity extractor (no model download, no network).
//
// v7 heuristic: structural anti-boilerplate with NO feed-specific word lists
// (a hardcoded "install/usage/license" list would overfit README feeds and
// rot on news feeds). Code blocks, nav/header/footer/aside chrome and repeat
// headings never reach frequency counts; the lead scores double; every tag
// needs body evidence (title alone never suffices); owner shards and
// corpus-wide boilerplate (adaptive document-frequency veto) are vetoed.
// Standalone generic nouns ("system", "market", "power") are never tags.
// Returns no keyword tags when there is no real latin signal (e.g. CJK-only
// articles) so feed `<category>` tags stand alone.
// Deterministic and dependency-free so it runs inline on ingest and in the
// scheduler backfill on alpine without extra services.

export interface ExtractedTopics {
	tags: string[];
	topics: string[];
	entities: string[];
}

const STOPWORDS = new Set(
	(
		'a,about,above,after,again,against,all,also,am,an,and,any,are,as,at,be,because,been,' +
		'before,being,below,between,both,but,by,can,could,did,do,does,doing,down,during,each,' +
		'few,for,from,further,had,has,have,having,he,her,here,hers,herself,him,himself,his,how,' +
		'i,if,in,into,is,it,its,itself,just,like,me,more,most,my,myself,no,nor,not,now,of,off,' +
		'on,once,only,or,other,ought,our,ours,ourselves,out,over,own,same,she,should,so,some,' +
		'such,than,that,the,their,theirs,them,themselves,then,there,these,they,this,those,' +
		'through,to,too,under,until,up,very,via,was,we,were,what,when,where,which,while,who,' +
		'whom,why,with,would,you,your,yours,yourself,yourselves,say,said,says,new,one,two,' +
		'first,last,also,per,among,within,across,including,according,million,billion,year,' +
		'years,day,days,week,weeks,time,people,company,companies,report,reports,announced,' +
		'will,would,has,had,have,been,were,its,may,might,must,shall,need,needs,used,using,' +
		'use,make,made,take,taken,part,full,half,top,best,better,top,home,world,news,today,' +
		// v2: relative timestamps leaking from scraped chrome ("3 hrs ago").
		'ago,hour,hours,hr,hrs,minute,minutes,min,mins,second,seconds,sec,secs,' +
		'yesterday,tomorrow,tonight,' +
		// v2: pagination / web chrome tokens.
		'page,pages,paging,http,https,www,html,htm,com,cn,net,org,gov,edu,php,aspx,jsp,' +
		'url,link,links,image,images,photo,photos,video,videos,post,posts,article,articles,' +
		'story,stories,blog,site,sites,website,web,internet,online,email,rss,feed,subscribe,' +
		'subscriber,newsletter,advertisement,ads,sponsored,cookie,cookies,privacy,terms,' +
		'copyright,reserved,click,share,shared,sharing,follow,menu,search,signin,sign,login,' +
		'logout,register,account,profile,settings,comment,comments,reply,replies,thread,' +
		'back,next,prev,previous,more,less,least,behind,without,' +
		// v2: generic verbs / fillers that form junk bigrams ("little bit").
		'little,bit,lot,lots,kind,sort,thing,things,stuff,way,ways,side,end,let,lets,get,' +
		'gets,got,go,goes,going,come,comes,think,thinks,mean,means,seem,seems,look,looks,' +
		'turn,turns,swirl,swirls,help,helps,keep,keeps,start,starts,deal,deals,win,wins,' +
		'done,often,sometimes,always,never,ever,quite,rather,really,actually,many,much,' +
		'several,various,certain,given,right,left,write,writes,written,one,ones,know,known,' +
		'move,moves,moving,run,runs,running,lesson,lessons,refuse,something,learned,' +
		'around,want,wants,talk,talks,long,short,fix,fixed,please,cheap,additional,' +
		'breakdown,understand,hate,measurable,boost,stop,stops,build,built,era,' +
		'existing,limit,limited,' +
		// v3: headline verbs that masquerade as topics ("China eye minerals").
		'eye,eyes,' +
		// v4: weak title words that survived anchoring ("lost lead", "well…").
		'well,lead,lost,deliver,delivered,delivering,despite,robust,peer,opaque,' +
		'mystery,question,topic,set,spot,industrial,related,return,sight,shouldn,' +
		'raise,failed,mull,happen,held,promise,promised,opinion,making,tell,told,' +
		'exist,grow,seiz,park,green,cold,rich,economic,design,designing,pressure,' +
		'heat,regime,bonus,baby,availability,rule,master,mall,pretend,pretending,' +
		'production,taxing,normalise,normalised,normalize,normalized,climb,climbed,' +
		'climbing,don,launch,unexpected,capital,domestic,declare,declared,gain,' +
		'guide,fair,app,career,lender,deployment,delivery,meant,ocean,risk,' +
		// v5: more weak singletons observed in the corpus. ("european" lives in
		// GENERIC_NOUNS instead — it must not break "European Central Bank".)
		'turning,demand,increase,increasing,increased,dim,test,testing,' +
		'insane,insanely,special,trainer,concern,stupid,chair,trust,trusting,' +
		'trusted,memory,future,face,weapon,compile,owned,budding,buy,upbeat,job,' +
		'jobless,tried,speak,speaks,speaking,spoke,finally,final,pilot,kill,kills,' +
		'killed,killing,favorite,clone,clones,cloned,double,dream,career,compliance,' +
		'illicit,release,released,releasing,powered,tap,hurdle,tech,feature,enough,' +
		'age,starting,started,stay,stayed,stays,pin,pinned,deprecate,deprecated,' +
		'deprecating,catch,faster,fastest,fast,slow,slower,slowest,worse,worst,bad,' +
		'four,five,six,seven,eight,nine,ten,score,stage,vendor,practitioner,' +
		'provider,multi,ship,shipping,shipped,anyway,safe,beat,spelling,spell,' +
		'facility,caught,worth,raising,incredible,interim,word,slowed,hit,break,' +
		'cup,logistic,trained,offered,offer,offering,compliant,building,pass,' +
		'highest,higher,enable,enabled,enabling,protect,protected,protecting,' +
		'case,compress,compressed,compressing'
	).split(',')
);

/**
 * Generic nouns that repeat within an article but are useless as tags
 * ("system", "market", "power"). Blocked as standalone unigram tags only —
 * they may still appear inside bigrams ("power sector") and entities.
 * Compared after singularization.
 */
const GENERIC_NOUNS = new Set(
	(
		'agent,area,bank,big,business,code,coding,cost,county,engine,experience,' +
		'european,finance,firm,good,group,high,investor,knowledge,land,market,' +
		'model,official,plant,policy,power,price,program,project,property,rate,' +
		'record,resource,school,sector,service,solid,state,study,system,team,top'
	).split(',')
);

/** Sidebar/ad sentences that pollute the scrape ("Related topics …"). */
const BOILERPLATE_SENTENCE = [
	/related (topics|articles|stories|posts|news|reading)\b/i,
	/you may also like/i,
	/\bread also\b/i,
	/most (popular|read)\b/i,
	/popular stories/i,
	/\btrending\b/i,
	/sponsored/i,
	/advertisement/i,
	/newsletter/i,
	/sign up\b/i,
	/premium article/i,
	/full access/i,
	/already a subscriber/i,
	/log in to continue/i,
	/share this article/i,
	/subscribe for full access/i,
	/flash sale/i,
	/secure payments?/i,
	/free shipping/i,
	/cash on delivery/i,
	/\bshop now\b/i,
	/\bbuy now\b/i,
	/discount code/i
];

/** Drop boilerplate sentences before any other cleaning. */
function dropBoilerplateSentences(text: string): string {
	const parts = text.split(/(?<=[.!?…])\s+/);
	if (parts.length <= 1) return text;
	const kept = parts.filter((s) => !BOILERPLATE_SENTENCE.some((re) => re.test(s)));
	// Never wipe the whole text on an over-eager filter.
	return kept.length > 0 ? kept.join(' ') : text;
}

/**
 * Closed-class words that split capitalized runs in entity extraction.
 * Content words are deliberately absent: "New York" must stay whole while
 * "NVIDIA Just" splits into ["NVIDIA"].
 */
const GLUE_WORDS = new Set(
	(
		'the,a,an,and,or,of,in,on,at,to,for,from,with,by,their,his,her,its,our,my,' +
		'your,this,that,these,those,just,only,also,even,still,yet,as,than,but,' +
		'while,when,nor,so,how,what,why,who,whom,whose,which,where,whether,' +
		'there,here,is,are,was,were,be,been,am,did,do,does,vs,versus,v'
	).split(',')
);

/** Host-shard / protocol fragments that are never real tags. */
const CHROME_TOKENS = new Set([
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
	'pages'
]);

/** Strip boilerplate that otherwise becomes tags: ad/related sentences,URLs,
 * emails, relative timestamps, pagination footers, chevron runs, fenced code
 * blocks (raw-markdown path — the HTML path arrives as <pre> and is dropped
 * in textFromHtml; code is not prose), plus English contractions/possessives
 * ("isn't" -> "is", "Kenya's" -> "Kenya") so shards like "isn"/"s" never
 * enter the token stream. No word lists for feed-specific boilerplate here:
 * corpus-frequency (isCorpusBoilerplate) handles that adaptively. */
function stripBoilerplate(text: string): string {
	return (
		dropBoilerplateSentences(text)
			// Fenced code blocks (``` / ~~~) are not prose.
			.replace(/```[\s\S]*?(```|$)/g, ' ')
			.replace(/~~~[\s\S]*?(~~~|$)/g, ' ')
			// Markdown heading markers are structure, not words.
			.replace(/^#{1,6}\s+/gm, '')
			.replace(/n['’]t\b/gi, ' ')
			.replace(/['’](s|re|ve|ll|d|m)\b/gi, ' ')
			// URLs and emails (visible link text / footers like 81rc.mil.cn).
			.replace(/https?:\/\/[^\s)>\]]+/gi, ' ')
			.replace(/www\.[^\s)>\]]+/gi, ' ')
			.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, ' ')
			.replace(/\b[a-z0-9-]+(\.[a-z0-9-]+)+\b/gi, (m) =>
				/\.(com|cn|net|org|gov|edu|mil|io|co|html?|php|aspx|jsp)\b/i.test(m) ? ' ' : m
			)
			// Relative timestamps ("3 hrs ago", "5 mins ago").
			.replace(/\b\d+\s*(secs?|mins?|hrs?|hours?|days?|weeks?|months?|years?)\s+ago\b/gi, ' ')
			// Pagination footers ("Page 1 of 12", "第2页", ">>>>>>>").
			.replace(/\bpages?\s+\d+(\s+of\s+\d+)?\b/gi, ' ')
			.replace(/[>》]{3,}/g, ' ')
			.replace(/第\s*\d+\s*页/g, ' ')
			.replace(/共\s*\d+\s*页/g, ' ')
	);
}

/** Fold plurals so "systems"/"system" don't become two tags. */
function singularize(word: string): string {
	if (word.length <= 3) return word;
	if (word.endsWith('ies') && word.length > 5) return word.slice(0, -3) + 'y';
	if (/(ses|xes|zes|ches|shes)$/.test(word) && word.length > 5) return word.slice(0, -2);
	if (word.endsWith('s') && !/(ss|us)$/.test(word)) return word.slice(0, -1);
	return word;
}

/** Corpus snapshot for the adaptive boilerplate veto (see below). */
export interface CorpusStats {
	size: number;
	docFreq: Map<string, number>;
}

/**
 * Morphological key for document frequency: singularize + light suffix
 * folding so "install / installed / installation / installer" count as ONE
 * corpus word. Suffix rules only, no word lists: 2-letter suffixes need a
 * ≥5-char stem ("docker"/"server" survive), longer ones ≥4.
 */
export function dfKey(word: string): string {
	let s = singularize(word);
	const folds: [string, number][] = [
		['ation', 4],
		['ition', 4],
		['tion', 4],
		['sion', 4],
		['ing', 4],
		['ers', 4],
		['er', 5],
		['or', 5],
		['ed', 5]
	];
	for (const [suf, minStem] of folds) {
		if (s.length - suf.length >= minStem && s.endsWith(suf)) {
			s = s.slice(0, -suf.length);
			break;
		}
	}
	return s;
}

/** Content-word tokens for document frequency: no stopwords, no shards. */
export function docFreqTokens(text: string): string[] {
	const out: string[] = [];
	for (const raw of text
		.toLowerCase()
		.replace(/[^a-z\s-]/g, ' ')
		.split(/[\s-]+/)) {
		const t = raw.trim();
		if (!t || t.length < 3) continue;
		const s = singularize(t);
		if (STOPWORDS.has(s)) continue;
		out.push(dfKey(s));
	}
	return out;
}

/** Presence-per-document counts over a corpus snapshot. Pure. */
export function computeDocFreq(texts: string[]): Map<string, number> {
	const df = new Map<string, number>();
	for (const text of texts) {
		const seen = new Set(docFreqTokens(text));
		for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
	}
	return df;
}

/**
 * Adaptive boilerplate veto (the anti-"install" without word lists): a word
 * spread across a large share of YOUR corpus is boilerplate for your corpus
 * and useless as a tag — TF-IDF's IDF half. Inert on small corpora (<10
 * docs: insufficient signal) and when no snapshot is passed (tests, CJK
 * early-exit), so behavior degrades to the structural layers, never to junk.
 */
export function isCorpusBoilerplate(word: string, corpus: CorpusStats | undefined): boolean {
	if (!corpus || corpus.size < 10) return false;
	const threshold = Math.max(5, Math.floor(corpus.size * 0.35));
	return (corpus.docFreq.get(dfKey(word)) ?? 0) >= threshold;
}

/**
 * Digit-mixed shards ("sh26", "81rc", "70mw", "sh8tr") are almost always
 * amounts, model numbers or host fragments. Keep them only when the title
 * vouches for them AND they are long enough to be real identifiers
 * ("agent2agent"); shilling-style amounts never survive.
 */
function isJunkMixedToken(token: string, inTitle: boolean): boolean {
	if (!/[0-9]/.test(token) || !/[a-z]/.test(token)) return false;
	if (/^(ksh?|sh|usd|eur|gbp|ngn|tzs|ugx)\d/i.test(token)) return true;
	if (inTitle && token.length >= 6) return false;
	return true;
}

/**
 * Ordered raw tokens for adjacency-correct bigrams. Short tokens, numbers
 * and junk shards are kept as empty-string separators (never scored, but
 * they break adjacency) so no phrase ever spans a removed word: "Models in
 * Agentic" and "Kenya's grid" must not become "model agentic" / "kenya grid".
 */
function rawTokens(text: string, titleTokens?: Set<string>): string[] {
	const cleaned = stripBoilerplate(text)
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, ' ');
	const out: string[] = [];
	for (const raw of cleaned.split(/[\s-]+/)) {
		const t = raw.trim();
		if (!t) continue;
		if (t.length > 30) continue;
		if (t.length < 3 || /^\d+$/.test(t)) {
			out.push('');
			continue;
		}
		if (isJunkMixedToken(t, titleTokens?.has(t) ?? false)) {
			out.push('');
			continue;
		}
		out.push(t);
	}
	return out;
}

function tokenize(text: string, titleTokens?: Set<string>): string[] {
	const out: string[] = [];
	for (const t of rawTokens(text, titleTokens)) {
		if (!t) continue;
		if (STOPWORDS.has(t) || CHROME_TOKENS.has(t)) continue;
		const s = singularize(t);
		if (STOPWORDS.has(s) || CHROME_TOKENS.has(s)) continue;
		out.push(s);
	}
	return out;
}

/**
 * Capitalized phrases ("NVIDIA", "European Central Bank") from raw text.
 * Sidebar entities ("Gentrix Osano School" in related links) are filtered by
 * requiring repetition or title support: pass the article's title token set
 * (singularized, lowercase) to enforce it; without one every candidate needs
 * count>=2.
 */
export function extractEntities(raw: string, limit = 8, titleSet?: Set<string>): string[] {
	const cleaned = stripBoilerplate(raw);
	const seen = new Map<string, number>();
	const re = /\b([A-Z][a-zA-Z0-9&]*(?:\s+[A-Z][a-zA-Z0-9&]*)+|\b[A-Z]{2,}(?:[A-Z0-9]*)\b)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(cleaned)) !== null) {
		const name = m[1].trim().replace(/\s+/g, ' ');
		if (name.length < 2 || name.length > 60) continue;
		// Split runs on glue words ("NVIDIA Just" -> ["NVIDIA"]) so a valid
		// entity glued to a capitalized glue word still counts instead of the
		// whole run being vetoed. Only closed-class words split — content
		// words never do, so "New York" stays whole.
		let cur: string[] = [];
		const subs: string[] = [];
		for (const w of name.split(' ')) {
			const lower = w.toLowerCase();
			if (GLUE_WORDS.has(lower) || CHROME_TOKENS.has(lower)) {
				if (cur.length > 0) {
					subs.push(cur.join(' '));
					cur = [];
				}
			} else {
				cur.push(w);
			}
		}
		if (cur.length > 0) subs.push(cur.join(' '));
		for (const sub of subs) {
			if (sub.length < 2 || sub.length > 60) continue;
			// Single-letter shards ("Kenya G") are never entities.
			if (sub.split(' ').some((w) => w.length < 2 && w !== '&')) continue;
			seen.set(sub, (seen.get(sub) ?? 0) + 1);
		}
	}
	const inTitle = (name: string): boolean => {
		if (!titleSet || titleSet.size === 0) return false;
		const words = name.toLowerCase().split(/\s+/);
		// Single-letter shards ("Kenya G") never count as title support.
		if (words.some((w) => w.length < 2)) return false;
		// A name containing a stopword ("Ai Kill React Native") is a sentence
		// fragment, not an entity — it needs repetition to qualify.
		if (words.some((w) => STOPWORDS.has(w) || STOPWORDS.has(singularize(w)))) return false;
		return words.every((w) => titleSet.has(singularize(w)));
	};
	const kept: [string, number][] = [];
	for (const [name, count] of seen) {
		const words = name.split(' ').length;
		// Single-occurrence sidebar entities are dropped unless titled.
		if (count < 2 && !inTitle(name)) continue;
		if (words === 1) {
			// Single caps tokens need a minimum shape: len>=3 keeps AMD/NVIDIA,
			// while 2-letter shards like "QS" need repeated evidence.
			if (name.length >= 3) kept.push([name, count]);
			else if (name.length === 2 && count >= 3) kept.push([name, count]);
		} else {
			kept.push([name, count]);
		}
	}
	return kept
		.sort((a, b) => {
			const words = (s: string) => s.split(' ').length;
			return words(b[0]) - words(a[0]) || b[1] - a[1];
		})
		.slice(0, limit)
		.map(([name]) => name);
}

export function extractTopics(
	input: { title?: string | null; text?: string | null },
	limit = 5,
	corpus?: CorpusStats
): ExtractedTopics {
	const title = stripBoilerplate(input.title ?? '').slice(0, 500);
	const text = stripBoilerplate(input.text ?? '').slice(0, 5000);
	const titleTokens = new Set(
		title
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, ' ')
			.split(/[\s-]+/)
			.map((t) => singularize(t.trim()))
			.filter((t) => t && t.length >= 2)
	);
	// `owner/repo` titles: the pre-slash segments are usernames (structural
	// position, not a word list) and are never tag candidates.
	const ownerShards = new Set<string>();
	const slashParts = (input.title ?? '')
		.split('/')
		.map((p) => p.trim())
		.filter(Boolean);
	if (slashParts.length >= 2) {
		for (const part of slashParts.slice(0, -1)) {
			for (const w of part
				.toLowerCase()
				.replace(/[^a-z0-9\s-]/g, ' ')
				.split(/[\s-]+/)) {
				const s = singularize(w.trim());
				if (s.length >= 2) ownerShards.add(s);
			}
		}
	}
	// Lead bias (structural): summaries live at the top, boilerplate at the
	// bottom. Lead tokens score double; gates below use raw body evidence.
	const leadBoundary = (() => {
		const cut = text.slice(0, 500);
		const sp = cut.lastIndexOf(' ');
		return sp > 200 ? sp : cut.length;
	})();
	const titleToks = tokenize(title, titleTokens);
	const leadToks = tokenize(text.slice(0, leadBoundary), titleTokens);
	const restToks = tokenize(text.slice(leadBoundary), titleTokens);
	const bodyToks = [...leadToks, ...restToks];

	// No latin signal and no entities (e.g. CJK-only article): emit nothing
	// so feed `<category>` tags stand alone instead of junk like "page page".
	// A title-anchored entity alone (e.g. a bare video title) still tags.
	const latinChars = (titleToks.join(' ') + ' ' + bodyToks.join(' ')).replace(/[^a-z]/g, '').length;
	const earlyEntities = extractEntities(
		`${input.title ?? ''}. ${(input.text ?? '').slice(0, 2000)}`,
		8,
		titleTokens
	);
	if ((titleToks.length + bodyToks.length < 5 || latinChars < 20) && earlyEntities.length === 0) {
		return { tags: [], topics: [], entities: earlyEntities };
	}

	const scores = new Map<string, number>();
	for (const t of titleToks) scores.set(t, (scores.get(t) ?? 0) + 3);
	for (const t of leadToks) scores.set(t, (scores.get(t) ?? 0) + 2);
	for (const t of restToks) scores.set(t, (scores.get(t) ?? 0) + 1);
	// Body frequency per token: raw evidence for the gates below.
	const bodyCounts = new Map<string, number>();
	for (const t of bodyToks) bodyCounts.set(t, (bodyCounts.get(t) ?? 0) + 1);

	// Bigrams from adjacent raw tokens (title repeated for weight), so no
	// phrase ever spans a removed stopword ("Models in Agentic" must not
	// become "model agentic"). Title and body streams are counted separately
	// so body-only phrases qualify on body evidence alone.
	const titleRaw = [...rawTokens(title, titleTokens), ...rawTokens(title, titleTokens)];
	const bodyRaw = rawTokens(text, titleTokens);
	const rawStream = [...titleRaw, ...bodyRaw];
	const bigramScores = new Map<string, number>();
	const bigramBodyScores = new Map<string, number>();
	const countBigram = (stream: string[], into: Map<string, number>) => {
		for (let i = 0; i < stream.length - 1; i++) {
			// Raw forms gate first: singularizing first would mangle stopwords
			// ("this" -> "thi") and let them slip through ("thi model").
			const ra = stream[i];
			const rb = stream[i + 1];
			if (STOPWORDS.has(ra) || STOPWORDS.has(rb)) continue;
			if (CHROME_TOKENS.has(ra) || CHROME_TOKENS.has(rb)) continue;
			const a = singularize(ra);
			const b = singularize(rb);
			if (!a || !b || a.length < 3 || b.length < 3) continue;
			if (a === b) continue;
			if (STOPWORDS.has(a) || STOPWORDS.has(b)) continue;
			if (CHROME_TOKENS.has(a) || CHROME_TOKENS.has(b)) continue;
			const key = `${a} ${b}`;
			into.set(key, (into.get(key) ?? 0) + 1);
		}
	};
	countBigram(rawStream, bigramScores);
	countBigram(bodyRaw, bigramBodyScores);
	// v7: structural anti-boilerplate, no feed-specific word lists.
	// - Title is a boost, never sufficient: every unigram needs body evidence
	//   (3+ body mentions, or a title mention plus 1+ body mention), so pure
	//   title echoes and headline-only words can never tag.
	// - Owner shards (pre-slash username) and corpus-wide boilerplate
	//   (isCorpusBoilerplate: "install" dies on repo feeds, untouched on news
	//   feeds) are vetoed outright. Code blocks, nav chrome and repeat
	//   headings never reach frequency counts upstream.
	// - Lead tokens score double (summaries live at the top).
	// Entities carry their own specificity signal and are filtered separately.
	const titleSet = new Set([...titleTokens].map((t) => singularize(t)));
	const topUnigrams = [...scores.entries()]
		.filter(
			([w, s]) =>
				s >= 3 &&
				!GENERIC_NOUNS.has(w) &&
				!ownerShards.has(w) &&
				!isCorpusBoilerplate(w, corpus) &&
				((bodyCounts.get(w) ?? 0) >= 3 || (titleSet.has(w) && (bodyCounts.get(w) ?? 0) >= 1))
		)
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit * 2)
		.map(([w]) => w);
	const topBigrams = [...bigramScores.entries()]
		.filter(
			([key, s]) =>
				s >= 3 &&
				// A bigram of two generic nouns ("policy power") is still generic.
				key.split(' ').some((w) => !GENERIC_NOUNS.has(w)) &&
				!key.split(' ').some((w) => ownerShards.has(w)) &&
				// Both words corpus-boilerplate ("star fork") means the phrase
				// is feed chrome; one common word ("kenya power") is fine.
				!key.split(' ').every((w) => isCorpusBoilerplate(w, corpus)) &&
				((bigramBodyScores.get(key) ?? 0) >= 2 ||
					(key.split(' ').every((w) => titleSet.has(w)) && (bigramBodyScores.get(key) ?? 0) >= 1))
		)
		.slice(0, limit * 2)
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([w]) => w);

	const rawEntities = extractEntities(
		`${input.title ?? ''}. ${(input.text ?? '').slice(0, 2000)}`,
		8,
		titleSet
	);
	const entityTags = rawEntities
		.map((e) => e.toLowerCase())
		.filter((e) => {
			if (e.length < 3 || e.length > 40) return false;
			if (ownerShards.has(e)) return false;
			const words = e.split(' ');
			// Sentence-titles ("did ai kill react native") are not tags.
			if (words.length > 4) return false;
			// Stutter phrases ("Timesfm Timesfm") are header echoes, not names.
			if (words.length > 1 && words.every((w) => singularize(w) === singularize(words[0])))
				return false;
			if (words.some((w) => STOPWORDS.has(w) || STOPWORDS.has(singularize(w)))) return false;
			return true;
		})
		.slice(0, 2);

	// Merge: entities first, then unigrams, then bigrams to fill.
	// Dedupe both directions so "systems" never coexists with "agentic
	// systems" — including word-order dups ("agent coding"/"coding agents").
	const tags: string[] = [];
	const bagKey = (s: string) =>
		s
			.split(' ')
			.map((w) => singularize(w))
			.sort()
			.join(' ');
	const covers = (list: string[], w: string) =>
		list.some((t) => {
			if (t === w || t.includes(w) || w.includes(t)) return true;
			return bagKey(t) === bagKey(w);
		});
	for (const e of entityTags) {
		if (tags.length >= limit) break;
		if (!covers(tags, e)) tags.push(e);
	}
	for (const u of topUnigrams) {
		if (tags.length >= limit) break;
		if (!covers(tags, u)) tags.push(u);
	}
	for (const b of topBigrams) {
		if (tags.length >= limit) break;
		if (!covers(tags, b)) tags.push(b);
	}

	const entities = rawEntities;
	const topics = tags.slice();
	return { tags, topics, entities };
}

/** Strip HTML to plain text for the extractor. */
export function textFromHtml(html: string | null): string {
	if (!html) return '';
	// Structural drops (format-level, feed-agnostic — same principle as the
	// script/style strip): fenced code arrives as <pre>, page furniture as
	// nav/header/footer/aside. Code (`npm install x` × N) is not prose and
	// must never count toward tag frequency; nav chrome (repo file lists,
	// sign-in links, TOCs) is not article content.
	const dechromed = html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<pre[\s\S]*?<\/pre>/gi, ' ')
		.replace(/<(nav|header|footer|aside)[\s>][\s\S]*?<\/\1>/gi, ' ');
	// Headings count once: the first occurrence of each heading stays
	// eligible, but TOC + section + anchor repetition of the same title
	// ("Install") never reaches frequency gates.
	const seenHeaders = new Set<string>();
	const singleHeaders = dechromed.replace(
		/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
		(_m, _level: string, inner: string) => {
			const key = inner
				.replace(/<[^>]+>/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
				.toLowerCase();
			if (!key || seenHeaders.has(key)) return ' ';
			seenHeaders.add(key);
			return ` ${inner} `;
		}
	);
	return stripBoilerplate(
		singleHeaders
			.replace(/<[^>]+>/g, ' ')
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#39;|&apos;/g, "'")
			.replace(/\s+/g, ' ')
			.trim()
	);
}
