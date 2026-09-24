import { describe, expect, it } from 'vitest';
import { extractEntities, extractTopics, textFromHtml } from './keywords';

describe('extractTopics', () => {
	it('extracts tech keywords from an AI infrastructure article', () => {
		const out = extractTopics({
			title: 'NVIDIA unveils new AI infrastructure chips for data centers',
			text: 'NVIDIA announced AI infrastructure chips. Data centers will deploy NVIDIA chips for AI workloads. AMD competes with NVIDIA in AI chips.'
		});
		expect(out.tags.length).toBeGreaterThan(0);
		expect(out.tags.length).toBeLessThanOrEqual(5);
		const joined = out.tags.join(' ');
		expect(joined).toMatch(/nvidia|chips|infrastructure/);
	});

	it('returns empty for stopword-only input', () => {
		const out = extractTopics({ title: 'The and of', text: 'This is a the and' });
		expect(out.tags).toEqual([]);
	});

	it('caps at 5 tags', () => {
		const out = extractTopics({
			title: 'Apple Google Microsoft Amazon Meta Netflix Tesla Nvidia AMD Intel IBM',
			text: 'Apple Google Microsoft Amazon Meta Netflix Tesla Nvidia AMD Intel IBM '.repeat(10)
		});
		expect(out.tags.length).toBeLessThanOrEqual(5);
	});
});

describe('extractEntities', () => {
	it('finds capitalized org names anchored in the title', () => {
		const out = extractEntities(
			'NVIDIA and AMD compete while European Central Bank watches.',
			8,
			new Set(['nvidia', 'amd', 'european', 'central', 'bank', 'compete', 'watch'])
		);
		expect(out).toContain('NVIDIA');
		expect(out).toContain('AMD');
		expect(out).toContain('European Central Bank');
	});

	it('drops single-occurrence sidebar entities without title support', () => {
		const out = extractEntities(
			'Kenya eyes minerals. Related stories mention Gentrix Osano School once.'
		);
		expect(out).not.toContain('Gentrix Osano School');
		expect(out).not.toContain('Related');
	});
});

describe('textFromHtml', () => {
	it('strips tags and scripts', () => {
		expect(textFromHtml('<script>x()</script><p>Hello <b>world</b></p>')).toBe('Hello world');
		expect(textFromHtml(null)).toBe('');
	});

	it('strips urls, timestamps and pagination footers', () => {
		const out = textFromHtml(
			'<p>Read more at https://81rc.mil.cn/page/2.html contact@example.com</p>' +
				'<p>3 hrs ago Page 1 of 12 >>>>>>>> 第2页</p><p>Real content words here</p>'
		);
		expect(out).not.toMatch(/81rc|https?|example\.com|hrs ago|Page 1 of|>>>>|第2页/);
		expect(out).toMatch(/Real content/);
	});
});

describe('extractTopics junk regression', () => {
	it('never emits page/page duplicates, url shards or time chrome', () => {
		const out = extractTopics({
			title: '南部战区2026年面向社会公开招考专业技能类文职人员公告 >>>>>>>>',
			text: '作者：来源：军队人才网发布时间：2026-09-07 Page 1 of 3 https://81rc.mil.cn/page/2.html 5 hrs ago 10 mins ago'
		});
		expect(out.tags).toEqual([]);
		expect(out.topics).toEqual([]);
	});

	it('drops filler bigrams like "little bit" and verb shards', () => {
		const out = extractTopics({
			title: 'Kenya power sector deals and textile waste policies',
			text: 'Kenya power sector signs a deal that lets utilities deliver 70MW. Textile waste rules put costs on firms. A little bit of background on power sector reform. Kenya power sector breakthrough.'
		});
		for (const t of out.tags) {
			expect(t).not.toMatch(/little bit|lets|puts|costs put|engine behind|think mean/);
			expect(t.split(' ')[0]).not.toBe(t.split(' ')[1]);
		}
	});

	it('drops digit-mixed shards unless the title vouches for them', () => {
		const out = extractTopics({
			title: 'Horticultural products and scooters start landing',
			text: 'Ktb taps sh26 funds while scooters start landing. Records show sh780 share and 70mw deliver. Horticultural products land affordable. Scooters start rollout.'
		});
		expect(out.tags.join(' ')).not.toMatch(/sh26|sh780|70mw|ktb/);
	});

	it('prefers entities over generic bigrams', () => {
		const out = extractTopics({
			title: 'NVIDIA unveils new AI infrastructure chips for data centers',
			text: 'NVIDIA announced AI infrastructure chips. Data centers will deploy NVIDIA chips for AI workloads. AMD competes with NVIDIA in AI chips.'
		});
		expect(out.tags.join(' ')).toMatch(/nvidia/);
	});

	it('anchors keyword tags in the title, ignoring repeated sidebar text', () => {
		const out = extractTopics({
			title: 'Menengai geothermal plants deliver power to the grid',
			text: 'Menengai geothermal plants deliver power. Secure payments in Kenya. Flash sale ends soon. Secure payments in Kenya again. Flash sale deals. Menengai geothermal output grows. Secure payments in Kenya once more.'
		});
		const joined = out.tags.join(' ');
		expect(joined).toMatch(/menengai|geothermal/);
		expect(joined).not.toMatch(/secure payments|flash sale|payments/);
	});

	it('never emits standalone generic nouns', () => {
		const out = extractTopics({
			title: 'World Maritime Day: solid policies must power the sector',
			text: 'World Maritime Day celebrates solid policies. Policies must power the sector. The state supports the maritime sector. Power systems and business models matter. Maritime policy power sector state.'
		});
		for (const t of out.tags) {
			expect(t.split(' ')).not.toContain('power');
			expect(t.split(' ')).not.toContain('sector');
			expect(t.split(' ')).not.toContain('state');
			expect(t.split(' ')).not.toContain('model');
			expect(t.split(' ')).not.toContain('system');
			expect(t.split(' ')).not.toContain('business');
		}
		expect(out.tags.join(' ')).toMatch(/maritime/);
	});

	it('strips contractions and possessives before tokenizing', () => {
		const out = extractTopics({
			title: "Multi-Agent Coding Isn't Enough",
			text: "Multi-agent coding isn't enough. Kenya's grid expands. Agents aren't reliable yet. Multi-agent systems fail often. Agents aren't safe."
		});
		const joined = out.tags.join(' ');
		expect(joined).not.toMatch(/\bisn\b|\baren\b|\bs\b/);
		expect(joined).toMatch(/multi-agent|agent/);
	});

	it('collapses word-order dups like agent coding / coding agents', () => {
		const out = extractTopics({
			title: 'Multi-Agent Coding Agents Need Commitment',
			text: 'Multi-agent coding agents need a commitment layer. Agent coding teams ship fast. Coding agents review code. Agent coding practices matter.'
		});
		const bags = out.tags.map((t) => t.split(' ').sort().join(' '));
		expect(new Set(bags).size).toBe(bags.length);
	});

	it('never forms phrases across removed stopwords', () => {
		const out = extractTopics({
			title: 'Decision Models in Agentic Architectures',
			text: 'Decision models in agentic architectures interest engineers. Decision models in agentic architectures scale well. Decision models examined.'
		});
		expect(out.tags.join(' ')).not.toMatch(/model agentic/);
		expect(out.tags.join(' ')).toMatch(/decision model|agentic architecture/);
	});

	it('drops paywall and share boilerplate sentences', () => {
		const out = extractTopics({
			title: 'Menengai geothermal plants deliver power to the grid',
			text: 'Menengai geothermal plants power the grid. Premium Article. Get Full Access now. Already a subscriber? Log in to continue. Share this article. Menengai geothermal output grows daily.'
		});
		const joined = out.tags.join(' ');
		expect(joined).not.toMatch(/premium|access|subscriber|share/);
		expect(joined).toMatch(/menengai|geothermal/);
	});

	it('tags a title-anchored entity even with almost no body text', () => {
		const out = extractTopics({
			title: 'NVIDIA Just Lost Their Lead',
			text: 'NVIDIA Just Lost Their Lead - YouTube'
		});
		expect(out.tags).toEqual(['nvidia']);
	});

	it('never forms phrases across removed stopwords like this/that', () => {
		const out = extractTopics({
			title: 'What this model means for startups',
			text: 'Analysts debate what this model means. This model faces scrutiny. That model scales.'
		});
		expect(out.tags.join(' ')).not.toMatch(/thi model|that model/);
	});

	it('splits question-word-led runs like "How Kenyan"', () => {
		const out = extractEntities('How Kenyan businesses grow. How Kenyan banks lend.', 8);
		expect(out.join(' ')).not.toMatch(/How Kenyan/);
	});

	it('rejects sentence-titles as tags', () => {
		const out = extractTopics({
			title: 'Did AI Kill React Native?',
			text: 'Did AI Kill React Native? A video essay. React Native developers react. AI tools grow.'
		});
		const joined = out.tags.join(' ');
		expect(joined).not.toMatch(/did ai kill react native|ai kill/);
		expect(joined).toMatch(/react native/);
	});

	it('keeps multi-word entities with content words whole', () => {
		const out = extractEntities('Meeting in New York. New York hosts talks.', 8);
		expect(out).toContain('New York');
		expect(out).not.toContain('York');
	});

	it('splits entity runs on stopwords instead of vetoing them', () => {
		const out = extractEntities(
			'NVIDIA Just Lost Their Lead. NVIDIA ships chips.',
			8,
			new Set(['nvidia', 'just', 'lost', 'their', 'lead', 'ship', 'chip'])
		);
		expect(out).toContain('NVIDIA');
		expect(out).not.toContain('NVIDIA Just');
	});

	it('drops weak title words like lead, lost, well and despite', () => {
		const out = extractTopics({
			title: 'NVIDIA just lost their lead despite strong sales',
			text: 'NVIDIA just lost their lead despite strong sales growth. Well, analysts disagree. NVIDIA lead lost despite gains. NVIDIA sales remain strong.'
		});
		const words = out.tags.flatMap((t) => t.split(' '));
		for (const w of ['lead', 'lost', 'well', 'despite']) expect(words).not.toContain(w);
		expect(out.tags.join(' ')).toMatch(/nvidia/);
	});

	it('drops related-topics sentences and headline-verb fragments', () => {
		const out = extractTopics({
			title: 'US, China eye Mrima Hill minerals',
			text: 'US and China eye Mrima Hill minerals. Related topics: Mrima Hills Kenya mining licences. China eyes more minerals. Mrima Hill minerals matter.'
		});
		const joined = out.tags.join(' ');
		expect(joined).not.toMatch(/related topics|china eye/);
	});
});

describe('extractTopics golden corpus junk (phase-0 eval cases)', () => {
	it('never tags ad/sidebar sentences like "secure payments" or "flash sale"', () => {
		const out = extractTopics({
			title: 'Menengai geothermal expansion adds 70MW to Kenya grid',
			text:
				'Menengai geothermal expansion adds capacity. Kenya grid operator confirmed the geothermal plant output. ' +
				'Flash Sale! Shop now for discounts. Secure payments in Kenya with cash on delivery. ' +
				'The geothermal expansion near Menengai finishes next year.'
		});
		const joined = out.tags.join(' ');
		expect(joined).not.toMatch(/flash sale|secure payments|shop now|cash on delivery/);
		expect(joined).toMatch(/menengai|geothermal/);
	});

	it('never emits standalone generic nouns (power, system, model) as tags', () => {
		const out = extractTopics({
			title: 'Kenya power sector reform reshapes the electricity market',
			text: 'Kenya power sector reform continues. The power sector regulator set new tariffs. Power sector investors welcome the Kenya power sector plan.'
		});
		for (const t of out.tags) {
			if (!t.includes(' ')) expect(['power', 'system', 'model', 'market']).not.toContain(t);
		}
	});

	it('returns no keyword tags for CJK-only articles even with latin chrome', () => {
		const out = extractTopics({
			title: '南部战区2026年面向社会公开招考专业技能类文职人员公告',
			text: '作者：来源：军队人才网 发布时间：2026-09-07 http www page com 5 mins ago'
		});
		expect(out.tags).toEqual([]);
	});
});

describe('extractEntities junk regression', () => {
	it('drops single-use short caps shards like QS', () => {
		expect(extractEntities('根据需要，可择优招录QS世界排名前200名高校应届毕业生。')).not.toContain(
			'QS'
		);
	});

	it('keeps frequent short org names', () => {
		const out = extractEntities('NVIDIA and AMD compete. NVIDIA ships chips. AMD responds.');
		expect(out).toContain('NVIDIA');
		expect(out).toContain('AMD');
	});
});
