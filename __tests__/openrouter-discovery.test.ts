import { describe, it, expect } from 'vitest';
import { isFreeModel } from '../providers/openrouter.js';

function makeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test/model',
    name: 'Test Model',
    created: 1710000000,
    context_length: 8192,
    architecture: { modality: 'text', tokenizer: 'test', instruct_type: undefined },
    pricing: { prompt: '0', completion: '0', image: '0', request: '0' },
    top_provider: { context_length: 8192, max_completion_tokens: null, is_moderated: false },
    per_request_limits: null,
    ...overrides,
  };
}

const freeSuffix = makeModel({ id: 'google/gemma-3-12b-it:free', name: 'Gemma 3 12B (free)' });
const zeroPrice = makeModel({ id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', context_length: 131072 });
const paid = makeModel({ id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000, pricing: { prompt: '0.0000025', completion: '0.00001', image: '0', request: '0' } });
const cheap = makeModel({ id: 'meta-llama/llama-3.1-8b-instruct', name: 'Llama 3.1 8B', context_length: 131072, pricing: { prompt: '0.00000003', completion: '0.00000006', image: '0', request: '0' } });

describe('isFreeModel', () => {
  it('should accept :free suffix', () => {
    expect(isFreeModel(freeSuffix)).toBe(true);
  });

  it('should accept zero pricing', () => {
    expect(isFreeModel(zeroPrice)).toBe(true);
  });

  it('should reject paid model', () => {
    expect(isFreeModel(paid)).toBe(false);
  });

  it('should reject cheap but non-zero', () => {
    expect(isFreeModel(cheap)).toBe(false);
  });
});
