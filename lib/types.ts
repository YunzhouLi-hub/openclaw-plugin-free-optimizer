/**
 * Canonical representation of a free model discovered from any platform.
 */
export interface PlatformModel {
  /** Platform identifier, e.g. 'openrouter', 'groq', 'google' */
  providerId: string;

  /** Model ID as used by the provider's API, e.g. 'meta-llama/llama-3.3-70b-instruct' */
  modelId: string;

  /** Human-readable display name */
  displayName: string;

  /** Context window size in tokens */
  contextLength: number;

  /** Always true for models in this plugin's scope */
  isFree: true;

  /** Per-token pricing (0 = free) */
  pricing: {
    prompt: number;
    completion: number;
  };

  /** Modality capability: 'text', 'text+image', 'text+image+audio', etc. */
  modality: string;

  /** Epoch ms when this model was last discovered/verified */
  discoveredAt: number;
}

/**
 * Benchmark result for a single model after a latency probe.
 */
export interface BenchmarkResult {
  model: PlatformModel;
  /** Time to first token in milliseconds (TTFT) */
  ttftMs: number;
  /** Whether the probe succeeded */
  success: boolean;
  /** Error message if probe failed */
  error?: string;
  /** Timestamp of the probe */
  probedAt: number;
  /** Quality score: 0 (garbage) to 5 (perfect). Based on benchmark reply content. */
  qualityScore?: number;
}

/** Cache TTL for a successful benchmark entry (ms). Default: 5 min */
export type BenchmarkCacheConfig = {
  ttlMs: number;
  /** Max age for stale-but-usable results when no fresh data is available (ms) */
  staleTtlMs: number;
};

/**
 * Ranked model entry combining the model definition with its latest benchmark.
 */
export interface RankedModel extends BenchmarkResult {
  /** Numeric rank (1 = fastest). `null` when benchmark hasn't run yet. */
  rank: number | null;
  /** User-assigned tag: 'preferred' floats to top, 'avoid' sinks below default */
  tag?: 'preferred' | 'avoid';
}

/**
 * Internal state persisted between polling cycles.
 */
export interface OptimizerState {
  /** All discovered free models keyed by "providerId/modelId" */
  models: Record<string, PlatformModel>;
  /** Latest benchmark results keyed by "providerId/modelId" */
  benchmarks: Record<string, BenchmarkResult>;
  /** Epoch ms of last full discovery run per provider */
  lastDiscoveryAt: Record<string, number>;
  /** Currently active (fastest) model */
  activeModel: string | null;
}
