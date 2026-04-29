import { describe, it, expect, vi, beforeEach } from 'vitest';
import { benchmarkModel, benchmarkModels } from '../lib/benchmarker.js';

// Mock fetch for controlled tests.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeSSEStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const encoded = chunks.map(c => encoder.encode(c));
  return new ReadableStream({
    start(controller) {
      for (const e of encoded) controller.enqueue(e);
      controller.close();
    },
  });
}

describe('benchmarkModel', () => {
  beforeEach(() => mockFetch.mockReset());

  it('should succeed for a valid streaming response', async () => {
    const delta = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\n`;
    const done = 'data: [DONE]\n\n';

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: makeSSEStream(delta, done),
    });

    const result = await benchmarkModel({
      apiKey: 'test-key',
      baseUrl: 'https://api.test.com/v1',
      modelId: 'test-model',
      maxResponseTime: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should report HTTP errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    const result = await benchmarkModel({
      apiKey: 'bad-key',
      baseUrl: 'https://api.test.com/v1',
      modelId: 'test-model',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
  });

  it('should retry on 429 and eventually fail', async () => {
    // First two calls return 429, third returns 429 (exhausted)
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    });

    const result = await benchmarkModel({
      apiKey: 'test-key',
      baseUrl: 'https://api.test.com/v1',
      modelId: 'test-model',
      maxResponseTime: 5000,
      retryOnFailure: 1,
      retryDelayMs: 10, // fast retries for test
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('429');
    // fetch should have been called twice (initial + 1 retry)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should succeed on 429 retry', async () => {
    const delta = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Yo' } }] })}\n\n`;
    const done = 'data: [DONE]\n\n';

    // First call returns 429, second succeeds
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' })
      .mockResolvedValueOnce({ ok: true, status: 200, body: makeSSEStream(delta, done) });

    const result = await benchmarkModel({
      apiKey: 'test-key',
      baseUrl: 'https://api.test.com/v1',
      modelId: 'test-model',
      maxResponseTime: 5000,
      retryOnFailure: 1,
      retryDelayMs: 10,
    });

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('benchmarkModels', () => {
  beforeEach(() => mockFetch.mockReset());

  it('should benchmark multiple models with concurrency control', async () => {
    const delta = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`;
    const done = 'data: [DONE]\n\n';

    mockFetch.mockImplementation(() => Promise.resolve({
      ok: true,
      status: 200,
      body: makeSSEStream(delta, done),
    }));

    const models = [
      { providerId: 'test', modelId: 'a', displayName: 'A', contextLength: 8000, isFree: true as const, pricing: { prompt: 0, completion: 0 }, modality: 'text', discoveredAt: 1 },
      { providerId: 'test', modelId: 'b', displayName: 'B', contextLength: 8000, isFree: true as const, pricing: { prompt: 0, completion: 0 }, modality: 'text', discoveredAt: 2 },
    ];

    const results = await benchmarkModels(models, (m: { modelId: string }) => ({
      apiKey: 'test',
      baseUrl: 'https://api.test.com/v1',
      modelId: m.modelId,
    }), 2);

    expect(results).toHaveLength(2);
    expect(results.filter(r => r.success)).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should skip models when config factory returns null', async () => {
    const models = [
      { providerId: 'test', modelId: 'a', displayName: 'A', contextLength: 8000, isFree: true as const, pricing: { prompt: 0, completion: 0 }, modality: 'text', discoveredAt: 1 },
    ];

    const results = await benchmarkModels(models, () => null, 1);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('No API key');
  });
});
