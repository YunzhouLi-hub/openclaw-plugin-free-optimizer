import type { PlatformModel, BenchmarkResult, RankedModel, OptimizerState } from './types.js';

/** Default TTL for cache validation */
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
export const DEFAULT_STALE_TTL_MS = 30 * 60 * 1000; // 30 min

const DEFAULT_STATE: OptimizerState = {
  models: {},
  benchmarks: {},
  lastDiscoveryAt: {},
  activeModel: null,
};

/**
 * Ranking engine: merges discovery + benchmark data into a sorted list.
 *
 * Ranking criteria (by priority):
 *  1. Success status (models that responded are always ranked higher)
 *  2. Preferred/avoid tags (preferred models float to top, avoid models sink)
 *  3. Quality score descending (models that gave correct/succinct answers rank higher)
 *  4. TTFT ascending (faster = better rank)
 *  5. Context length as tiebreaker (larger context = preferred)
 *
 * Preferred/avoid matching is done against `providerId/modelId` key (case-insensitive).
 */
export function rankModels(
  models: PlatformModel[],
  benchmarks: BenchmarkResult[],
  preferredModels: string[] = [],
  avoidModels: string[] = []
): RankedModel[] {
  const benchMap = new Map<string, BenchmarkResult>();
  for (const b of benchmarks) {
    benchMap.set(`${b.model.providerId}/${b.model.modelId}`, b);
  }

  const isPreferred = (key: string): boolean => preferredModels.some(p => key.toLowerCase().includes(p.toLowerCase()));
  const isAvoid = (key: string): boolean => avoidModels.some(a => key.toLowerCase().includes(a.toLowerCase()));

  const ranked: RankedModel[] = models.map((model) => {
    const key = `${model.providerId}/${model.modelId}`;
    const bench = benchMap.get(key);

    return {
      model,
      ttftMs: bench?.success ? bench.ttftMs : Infinity,
      success: bench?.success ?? false,
      error: bench?.error,
      probedAt: bench?.probedAt ?? 0,
      qualityScore: bench?.qualityScore,
      tag: isPreferred(key) ? 'preferred' : isAvoid(key) ? 'avoid' : undefined,
      rank: null, // assigned after sort
    };
  });

  // Sort: success first, then tag (preferred > default > avoid), then quality (desc),
  //       then TTFT (asc), then context (desc)
  ranked.sort((a, b) => {
    if (a.success !== b.success) return a.success ? -1 : 1;

    const tagOrder: Record<string, number> = { preferred: 0, default: 1, avoid: 2 };
    const tagA = tagOrder[a.tag ?? 'default'] ?? 1;
    const tagB = tagOrder[b.tag ?? 'default'] ?? 1;
    if (tagA !== tagB) return tagA - tagB;

    const qA = a.qualityScore ?? 3;
    const qB = b.qualityScore ?? 3;
    if (qA !== qB) return qB - qA; // Higher quality first

    if (a.ttftMs !== b.ttftMs) return a.ttftMs - b.ttftMs;
    return b.model.contextLength - a.model.contextLength;
  });

  // Assign rank numbers
  let currentRank = 0;
  for (const entry of ranked) {
    if (entry.success) {
      entry.rank = ++currentRank;
    } else {
      entry.rank = null;
    }
  }

  return ranked;
}

/**
 * Get the currently best-ranked model.
 * Returns null if no model has been successfully benchmarked.
 */
export function getBestModel(ranked: RankedModel[]): RankedModel | null {
  return ranked.find((r) => r.success && r.rank === 1) ?? null;
}

/**
 * Get the best healthy (non-stale) model from the ranked list.
 * Filters out stale entries and returns the freshest fast model.
 *
 * @param ranked Full ranked list
 * @param now Current epoch ms
 * @param cacheTtlMs Max age for a "fresh" benchmark
 * @returns Best fresh model, or null if none
 */
export function getBestFreshModel(
  ranked: RankedModel[],
  now: number = Date.now(),
  cacheTtlMs: number = DEFAULT_CACHE_TTL_MS
): RankedModel | null {
  const fresh = ranked
    .filter(r => r.success && r.probedAt > 0 && (now - r.probedAt) <= cacheTtlMs);
  // Already sorted by rank (1 = fastest)
  for (const r of fresh) {
    if (r.rank === 1) return r;
  }
  // If rank 1 not fresh, best fresh is the first one
  return fresh[0] ?? null;
}

/**
 * Fallback chain: try best fresh, then best overall (stale allowed), then null.
 *
 * @returns [bestFresh, bestOverall] for the caller to decide
 */
export function getFallbackChain(
  ranked: RankedModel[]
): { primary: RankedModel | null; fallback: RankedModel | null } {
  const primary = ranked.find(r => r.success && r.rank === 1) ?? null;
  const fallback = ranked.find(r => r.success && r.rank && r.rank <= 3 && r.model.modelId !== primary?.model.modelId) ?? null;
  return { primary, fallback };
}

/**
 * Check if a benchmark result is still fresh enough to use without re-testing.
 */
export function isBenchmarkFresh(
  bench: BenchmarkResult | undefined,
  now: number = Date.now(),
  cacheTtlMs: number = DEFAULT_CACHE_TTL_MS
): boolean {
  if (!bench?.success) return false;
  return (now - bench.probedAt) <= cacheTtlMs;
}

/**
 * Check if a benchmark result is stale but usable as a fallback.
 */
export function isBenchmarkStaleButUsable(
  bench: BenchmarkResult | undefined,
  now: number = Date.now(),
  staleTtlMs: number = DEFAULT_STALE_TTL_MS
): boolean {
  if (!bench) return false;
  return (now - bench.probedAt) <= staleTtlMs;
}

/**
 * Persist state to a JSON file.
 */
export async function saveState(state: OptimizerState, filePath: string): Promise<void> {
  const fs = await import('fs/promises');
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Load state from a JSON file. Returns default empty state if file doesn't exist.
 */
export async function loadState(filePath: string): Promise<OptimizerState> {
  const fs = await import('fs/promises');
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as OptimizerState;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * Print a ranked table to stdout.
 */
export function printRankingTable(ranked: RankedModel[]): void {
  if (ranked.length === 0) {
    console.log('No models to rank.');
    return;
  }

  const now = Date.now();

  console.log('\n┌──────┬────────────────────────────────────────────────┬────────┬─────────┬──────┬──────────┬────────────┐');
  console.log('│ Rank │ Model                                          │ TTFT   │ Qual   │ Tag │ Ctx      │ Age        │');
  console.log('├──────┼────────────────────────────────────────────────┼────────┼─────────┼──────┼──────────┼────────────┤');

  for (const r of ranked) {
    const rank = r.rank ? String(r.rank).padStart(4) : '   -';
    const modelLabel = `${r.model.providerId}/${r.model.modelId}`.padEnd(48).slice(0, 48);
    const ttft = r.success ? `${r.ttftMs}ms`.padEnd(6) : '    - ';
    const qual = r.qualityScore != null ? `${'★'.repeat(r.qualityScore)}${'☆'.repeat(5 - r.qualityScore)}` : '  ???  ';
    const tag = r.tag === 'preferred' ? '⭐' : r.tag === 'avoid' ? '🚫' : '   ';
    const ctx = r.model.contextLength > 0
      ? formatTokens(r.model.contextLength).padEnd(8)
      : '      - ';
    const age = r.probedAt > 0 ? formatAge(now - r.probedAt).padEnd(10) : '          ';

    console.log(`│ ${rank} │ ${modelLabel} │ ${ttft} │ ${qual} │ ${tag}  │ ${ctx}│ ${age}│`);

    if (r.error && !r.success) {
      console.log(`│      │ Error: ${r.error.padEnd(48)}│`);
    }
  }

  console.log('└──────┴────────────────────────────────────────────────┴────────┴─────────┴──────┴──────────┴────────────┘\n');

  const best = getBestModel(ranked);
  if (best) {
    const freshness = isBenchmarkFresh(best, now) ? 'fresh' : 'stale';
    const tagHint = best.tag === 'preferred' ? ' (preferred ⭐)' : best.tag === 'avoid' ? ' (avoided 🚫)' : '';
    console.log(`🏆 Best model: ${best.model.providerId}/${best.model.modelId}${tagHint} (${best.ttftMs}ms TTFT, ${freshness})`);
  } else {
    console.log('⚠ No model has been successfully benchmarked yet.');
  }
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
  return String(count);
}

export function formatAge(ageMs: number): string {
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m`;
  return `${Math.round(ageMs / 3_600_000)}h`;
}
