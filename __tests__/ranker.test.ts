import { describe, it, expect } from 'vitest';
import type { PlatformModel, BenchmarkResult } from '../lib/types.js';
import { rankModels, getBestModel } from '../lib/ranker.js';

function makeModel(overrides: Partial<PlatformModel> & { modelId: string }): PlatformModel {
  return {
    providerId: 'test',
    displayName: overrides.modelId,
    contextLength: 8192,
    isFree: true,
    pricing: { prompt: 0, completion: 0 },
    modality: 'text',
    discoveredAt: 1000,
    ...overrides,
  };
}

function makeBenchmark(model: PlatformModel, overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    model,
    ttftMs: 500,
    success: true,
    probedAt: Date.now(),
    ...overrides,
  };
}

describe('rankModels', () => {
  it('should sort faster models first', () => {
    const fast = makeModel({ modelId: 'fast', contextLength: 8000 });
    const slow = makeModel({ modelId: 'slow', contextLength: 8000 });

    const ranked = rankModels(
      [slow, fast],
      [makeBenchmark(slow, { ttftMs: 2000 }), makeBenchmark(fast, { ttftMs: 500 })]
    );

    expect(ranked[0].rank).toBe(1);
    expect(ranked[0].model.modelId).toBe('fast');
    expect(ranked[1].rank).toBe(2);
    expect(ranked[1].model.modelId).toBe('slow');
  });

  it('should rank successful probes above failures', () => {
    const good = makeModel({ modelId: 'good' });
    const bad = makeModel({ modelId: 'bad' });

    const ranked = rankModels(
      [bad, good],
      [
        makeBenchmark(bad, { success: false }),
        makeBenchmark(good, { ttftMs: 300 }),
      ]
    );

    expect(ranked[0].model.modelId).toBe('good');
    expect(ranked[0].success).toBe(true);
    expect(ranked[1].success).toBe(false);
    expect(ranked[1].rank).toBeNull();
  });

  it('should break ties by larger context', () => {
    const small = makeModel({ modelId: 'small', contextLength: 4000 });
    const large = makeModel({ modelId: 'large', contextLength: 128000 });

    const ranked = rankModels(
      [small, large],
      [makeBenchmark(small, { ttftMs: 500 }), makeBenchmark(large, { ttftMs: 500 })]
    );

    expect(ranked[0].model.modelId).toBe('large');
    expect(ranked[1].model.modelId).toBe('small');
  });

  it('should sort preferred models above equal-quality defaults', () => {
    const fast = makeModel({ providerId: 'fastp', modelId: 'default-model' });
    const preferred = makeModel({ providerId: 'prefp', modelId: 'preferred-model' });

    const ranked = rankModels(
      [fast, preferred],
      [
        makeBenchmark(fast, { ttftMs: 200 }),
        makeBenchmark(preferred, { ttftMs: 300 }),
      ],
      ['prefp/preferred-model'], // preferredModels
      []
    );

    expect(ranked[0].model.modelId).toBe('preferred-model');
    expect(ranked[0].tag).toBe('preferred');
    expect(ranked[1].model.modelId).toBe('default-model');
  });

  it('should push avoid models below defaults', () => {
    const norm = makeModel({ providerId: 'norm', modelId: 'normal-model' });
    const avoid = makeModel({ providerId: 'avoid', modelId: 'avoid-model' });

    const ranked = rankModels(
      [avoid, norm],
      [
        makeBenchmark(avoid, { ttftMs: 100 }),
        makeBenchmark(norm, { ttftMs: 200 }),
      ],
      [],
      ['avoid/avoid-model']
    );

    expect(ranked[0].model.modelId).toBe('normal-model');
    expect(ranked[0].tag).toBeUndefined();
    expect(ranked[1].model.modelId).toBe('avoid-model');
    expect(ranked[1].tag).toBe('avoid');
  });

  it('should handle empty models list', () => {
    const ranked = rankModels([], []);
    expect(ranked).toHaveLength(0);
  });

  it('should assign null rank to unbenchmarked models', () => {
    const m = makeModel({ modelId: 'unbenchmarked' });

    const ranked = rankModels([m], []);

    expect(ranked).toHaveLength(1);
    expect(ranked[0].rank).toBeNull();
    expect(ranked[0].success).toBe(false);
  });
});

describe('getBestModel', () => {
  it('should return the rank-1 model', () => {
    const m = makeModel({ modelId: 'best' });
    const ranked = rankModels(
      [m],
      [makeBenchmark(m, { ttftMs: 100 })]
    );

    const best = getBestModel(ranked);
    expect(best).not.toBeNull();
    expect(best!.model.modelId).toBe('best');
    expect(best!.rank).toBe(1);
  });

  it('should return null when no model succeeded', () => {
    const m = makeModel({ modelId: 'fail' });
    const ranked = rankModels(
      [m],
      [makeBenchmark(m, { success: false })]
    );

    expect(getBestModel(ranked)).toBeNull();
  });
});
