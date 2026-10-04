// Shared tag-hygiene helpers: junk detection + dup keys for consolidation.
//
// Dependency-free so tsx scripts (clean-tags, retopic) share the exact rules
// with the live consolidate path. Mirrors the sets previously inline in
// scripts/clean-tags.ts and the singularize/bagKey rules in labels.ts.

const EXACT_JUNK = new Set([
	'page page',
	'page',
	'pages',
	'http',
	'https',
	'www',
	'html',
	'81rc',
	'ago',
	'min ago',
	'mins ago',
	'min',
	'mins',
	'hrs ago',
	'hrs',
	'secs ago',
	'secs',
	// Verified sidebar/ad junk (each checked against every article carrying it).
	'secure payments kenya',
	'flash sale',
	'gentrix osano school',
	'united nations general assembly',
	'java9',
	// Plural dup of a canonical tag ("incident").
	'incidents'
]);

const CHROME = new Set([
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
	'pages',
	'81rc'
]);

// Filler verbs/generic nouns whose presence marks a bigram as junk
// ("costs put", "engine behind", "little bit", "learn babies").
const FILLER = new Set(
	(
		'let,lets,make,made,take,put,get,got,go,goes,going,come,comes,think,thinks,' +
		'mean,means,seem,seems,look,looks,turn,turns,swirl,swirls,help,helps,keep,keeps,' +
		'start,starts,deal,deals,win,wins,learn,behind,without,end,side,back,little,bit,' +
		'lot,lots,kind,sort,thing,things,stuff,way,ways,become,becomes,becoming,done,' +
		'ahead,around,right,left,write,ones,know,move,run,runs,running,lesson,actually,' +
		'refuse,something,learned,want,wants,talk,talks,long,short,fix,fixed,please,' +
		'cheap,additional,breakdown,understand,hate,measurable,boost,eye,eyes,stop,stops,' +
		'build,built,era,existing,limit,limited,well,lead,lost,deliver,delivered,' +
		'delivering,despite,robust,peer,opaque,mystery,question,topic,set,spot,' +
		'industrial,related,return,sight,shouldn,raise,failed,mull,happen,held,' +
		'promise,promised,opinion,making,tell,told,exist,grow,seiz,park,green,cold,' +
		'rich,economic,design,designing,pressure,heat,regime,bonus,baby,availability,' +
		'rule,master,mall,pretend,pretending,production,taxing,normalise,normalised,' +
		'normalize,normalized,climb,climbed,climbing,don,launch,unexpected,capital,' +
		'domestic,declare,declared,gain,guide,fair,app,career,lender,deployment,' +
		'delivery,meant,ocean,risk,turning,demand,increase,increasing,' +
		'increased,dim,test,testing,insane,insanely,special,trainer,concern,stupid,' +
		'chair,trust,trusting,trusted,memory,future,face,weapon,compile,owned,' +
		'budding,buy,upbeat,job,jobless,tried,speak,speaks,speaking,spoke,finally,' +
		'final,pilot,kill,kills,killed,killing,favorite,clone,clones,cloned,double,' +
		'dream,career,compliance,illicit,release,released,releasing,powered,tap,' +
		'hurdle,tech,feature,enough,age,starting,started,stay,stayed,stays,pin,' +
		'pinned,deprecate,deprecated,deprecating,catch,faster,fastest,fast,slow,' +
		'slower,slowest,worse,worst,bad,four,five,six,seven,eight,nine,ten,score,' +
		'stage,vendor,practitioner,provider,multi,ship,shipping,shipped,anyway,' +
		'safe,beat,spelling,spell,facility,caught,worth,raising,incredible,' +
		'interim,word,slowed,hit,break,cup,logistic,trained,offered,offer,' +
		'offering,compliant,building,pass,highest,higher,enable,enabled,' +
		'enabling,protect,protected,protecting,case,compress,compressed,' +
		'compressing'
	).split(',')
);

// Standalone generic nouns: junk only as single-word tags ("model", "power").
// Mirrors GENERIC_NOUNS in the extractor; multi-word tags are left alone.
const GENERIC = new Set(
	(
		'agent,area,bank,big,business,code,coding,cost,county,engine,experience,' +
		'european,finance,firm,good,group,high,investor,knowledge,land,market,' +
		'model,official,plant,policy,power,price,program,project,property,rate,' +
		'record,resource,school,sector,service,solid,state,study,system,team,top'
	).split(',')
);

export function singularize(word: string): string {
	if (word.length <= 3) return word;
	if (word.endsWith('ies') && word.length > 5) return word.slice(0, -3) + 'y';
	if (/(ses|xes|zes|ches|shes)$/.test(word) && word.length > 5) return word.slice(0, -2);
	if (word.endsWith('s') && !/(ss|us)$/.test(word)) return word.slice(0, -1);
	return word;
}

/** Lowercased singular-form key preserving word order ("coding agents" → "coding agent"). */
export function singularKey(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.map((w) => singularize(w))
		.join(' ');
}

/** Order-insensitive singular bag ("agent coding" ≡ "coding agent"). */
export function bagKey(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.map((w) => singularize(w))
		.filter((w) => w.length >= 2)
		.sort()
		.join(' ');
}

/** Conservative dup test for consolidation: same singular form or same word bag. */
export function isSameTag(a: string, b: string): boolean {
	if (a === b) return true;
	return singularKey(a) === singularKey(b) || bagKey(a) === bagKey(b);
}

export function isJunkTag(name: string): boolean {
	const n = name.trim().toLowerCase();
	if (!n) return true;
	if (EXACT_JUNK.has(n)) return true;
	if (/\b\d+\s*(secs?|mins?|hrs?|hours?|days?|weeks?)\s+ago\b/.test(n)) return true;
	const parts = n.split(/\s+/);
	// Repeated phrase ("page page", "claude code claude code") or stutter
	// ("microduck rl rl"): extractor echo, never a real tag.
	if (parts.length >= 2) {
		let adjacentRepeat = false;
		for (let i = 1; i < parts.length; i++) {
			if (singularize(parts[i]) === singularize(parts[i - 1])) {
				adjacentRepeat = true;
				break;
			}
		}
		if (adjacentRepeat) return true;
		if (parts.length % 2 === 0) {
			const half = parts.length / 2;
			const first = parts.slice(0, half).map((p) => singularize(p));
			const second = parts.slice(half).map((p) => singularize(p));
			if (first.every((w, i) => w === second[i])) return true;
		}
	}
	// Single-letter shards ("kenya g") are never real tags ('&' excepted).
	if (parts.some((p) => p.length < 2 && p !== '&')) return true;
	// Denylist membership (CHROME/FILLER/GENERIC) applies to single-word tags
	// only. Multi-word carriers ("claude code", "power grid",
	// "enterprise resource planning") are legitimate topics that merely
	// contain a generic word — flagging the whole phrase deletes real labels.
	if (parts.length === 1) {
		const s = singularize(n);
		if (CHROME.has(n) || CHROME.has(s)) return true;
		if (FILLER.has(n) || FILLER.has(s)) return true;
		if (GENERIC.has(n) || GENERIC.has(s)) return true;
	}
	for (const p of parts) {
		// digit-mixed shards ("sh26", "81rc", "70mw", "9bn")
		if (/[a-z]/.test(p) && /[0-9]/.test(p) && p.length < 5) return true;
		if (/^\d+[a-z]+$/.test(p) || /^[a-z]+\d+$/.test(p)) return true;
	}
	return false;
}
