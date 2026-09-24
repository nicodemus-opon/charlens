import { describe, expect, it } from 'vitest';
import {
	EMBED_DIM,
	_resetEmbeddingsForTests,
	_setEmbeddingsEnabledForTests,
	embedTexts,
	getEmbedModel
} from './embeddings';

describe('embeddings module', () => {
	it('exposes the 384-dim contract', () => {
		expect(EMBED_DIM).toBe(384);
		expect(getEmbedModel()).toContain('MiniLM');
	});

	it('degrades to nulls when disabled without loading the model', async () => {
		_resetEmbeddingsForTests();
		_setEmbeddingsEnabledForTests(false);
		try {
			const out = await embedTexts(['hello world']);
			expect(out).toEqual([null]);
		} finally {
			_resetEmbeddingsForTests();
		}
	});
});
