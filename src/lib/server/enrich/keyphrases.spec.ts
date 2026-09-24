import { describe, expect, it } from 'vitest';
import { groupKeyphrases, type KeyphraseToken } from './keyphrases';

const tok = (entity: string, word: string, score = 0.9): KeyphraseToken => ({
	entity,
	word,
	score
});

describe('groupKeyphrases', () => {
	it('groups B/I runs into phrases and joins ## subwords', () => {
		const out = groupKeyphrases([
			tok('O', 'The'),
			tok('B-KEYPHRASE', 'geothermal'),
			tok('I-KEYPHRASE', 'energy'),
			tok('O', 'in'),
			tok('B-KEYPHRASE', 'token'),
			tok('I-KEYPHRASE', '##ization')
		]);
		expect(out.map((g) => g.phrase)).toEqual(['geothermal energy', 'tokenization']);
	});

	it('breaks phrases on O labels', () => {
		const out = groupKeyphrases([
			tok('B-KEYPHRASE', 'machine'),
			tok('I-KEYPHRASE', 'learning'),
			tok('O', 'and'),
			tok('B-KEYPHRASE', 'solar'),
			tok('I-KEYPHRASE', 'power')
		]);
		expect(out.map((g) => g.phrase)).toEqual(['machine learning', 'solar power']);
	});

	it('ignores stray I- labels with no open phrase', () => {
		const out = groupKeyphrases([tok('I-KEYPHRASE', 'orphan'), tok('B-KEYPHRASE', 'real')]);
		expect(out.map((g) => g.phrase)).toEqual(['real']);
	});

	it('skips special tokens and averages token scores', () => {
		const out = groupKeyphrases([
			tok('O', '[CLS]', 1),
			tok('B-KEYPHRASE', 'ai', 0.8),
			tok('I-KEYPHRASE', 'chips', 1.0),
			tok('O', '[SEP]', 1)
		]);
		expect(out).toEqual([{ phrase: 'ai chips', score: 0.9 }]);
	});
});
