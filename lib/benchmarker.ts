import type { PlatformModel, BenchmarkResult } from '../lib/types.js';

/**
 * Benchmark configuration for a single probe run.
 */
export interface BenchmarkConfig {
  /** API key for the provider */
  apiKey: string;
  /** Base URL for the chat completions endpoint */
  baseUrl: string;
  /** Model ID to probe (provider-specific format) */
  modelId: string;
  /** Maximum time to wait for first token (ms). Default: 15000 */
  maxResponseTime?: number;
  /** Probe prompt. Default: 'What is the capital of France? Reply in one word.' */
  prompt?: string;
  /** Max tokens for the probe response. Default: 10 */
  maxTokens?: number;
  /** Number of retries on HTTP 429 / 5xx. Default: 2 */
  retryOnFailure?: number;
  /** Delay between retries (ms). Default: 3000 */
  retryDelayMs?: number;
}

const DEFAULT_MAX_RESPONSE_TIME = 15_000;
const DEFAULT_PROMPT = 'What is the capital of France? Reply in one word.';
const DEFAULT_MAX_TOKENS = 10;
const DEFAULT_RETRY_ON_FAILURE = 2;
const DEFAULT_RETRY_DELAY_MS = 3_000;

/** HTTP status codes that are safe to retry */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Score response quality based on the benchmark prompt.
 * Rules:
 *  - Contains "Paris" (case-insensitive): +2
 *  - Is extremely short (< 3 chars) or empty: -1
 *  - Response has extra fluff words ("However", "but", "actually", "though"): -1 (not following "reply in one word")
 *  - Max score: 5, Min score: 0
 */
export function scoreResponseQuality(prompt: string, response: string): number {
  const r = response.trim();
  if (!r) return 0;

  let score = 2; // baseline: model responded

  // Contains the correct answer "Paris" (case-insensitive)
  if (/paris/i.test(r)) {
    score += 2;
  }

  // Very short — good, followed "one word" instruction
  if (r.length <= 20) {
    score += 1;
  } else {
    // Too verbose — didn't follow "reply in one word"
    score -= 1;
  }

  // Extra fluff penalty
  const fluffWords = ['however', 'but ', 'actually', 'though', 'while', 'although', 'in fact', 'sure', 'certainly'];
  const hasFluff = fluffWords.some(w => r.toLowerCase().includes(w));
  if (hasFluff) score -= 1;

  return Math.max(0, Math.min(5, score));
}

/**
 * Measure Time To First Token (TTFT) for a single model.
 *
 * Uses streaming API to get the most accurate first-token latency.
 * After TTFT is recorded, continues reading the stream to collect the full
 * response for quality scoring.
 * Automatically retries on HTTP 429 / 5xx with configurable backoff.
 *
 * @returns BenchmarkResult with ttftMs, success, qualityScore, and optional error
 */
export async function benchmarkModel(
  config: BenchmarkConfig
): Promise<BenchmarkResult> {
  const {
    apiKey,
    baseUrl,
    modelId,
    maxResponseTime = DEFAULT_MAX_RESPONSE_TIME,
    prompt = DEFAULT_PROMPT,
    maxTokens = DEFAULT_MAX_TOKENS,
    retryOnFailure = DEFAULT_RETRY_ON_FAILURE,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = config;

  const result: BenchmarkResult = {
    model: {
      providerId: extractProviderId(baseUrl),
      modelId,
      displayName: modelId,
      contextLength: 0,
      isFree: true,
      pricing: { prompt: 0, completion: 0 },
      modality: 'text',
      discoveredAt: Date.now(),
    },
    ttftMs: 0,
    success: false,
    probedAt: Date.now(),
  };

  for (let attempt = 0; attempt <= retryOnFailure; attempt++) {
    const isRetry = attempt > 0;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), maxResponseTime);
    const startTime = performance.now();

    try {
      if (isRetry) {
        // Exponential backoff: 3s, 6s, 12s...
        const delay = retryDelayMs * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        result.ttftMs = Math.round(performance.now() - startTime);

        if (RETRYABLE_STATUS.has(res.status) && attempt < retryOnFailure) {
          result.error = `HTTP ${res.status} (attempt ${attempt + 1}/${retryOnFailure + 1})`;
          continue;
        }

        result.error = `HTTP ${res.status}: ${res.statusText}`;
        return result;
      }

      if (!res.body) {
        result.error = 'No response body (streaming not supported)';
        return result;
      }

      // Read stream: record TTFT at first token, collect full response for quality
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullResponse = '';
      let gotFirstToken = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // Keep incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') {
            break;
          }

          try {
            const data = JSON.parse(dataStr);
            const content = data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.text ?? '';
            if (content) {
              if (!gotFirstToken) {
                result.ttftMs = Math.round(performance.now() - startTime);
                gotFirstToken = true;
              }
              fullResponse += content;
            }
          } catch {
            // Malformed JSON, continue
          }
        }
      }

      if (!gotFirstToken) {
        result.error = 'Stream ended without receiving a token';
        return result;
      }

      // Quality scoring based on full response
      result.success = true;
      result.qualityScore = scoreResponseQuality(prompt, fullResponse);
      return result;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        result.error = `Timeout after ${maxResponseTime}ms`;
      } else {
        result.error = err instanceof Error ? err.message : String(err);
      }
      result.ttftMs = Math.round(performance.now() - startTime);

      // Retry on network errors too
      if (attempt < retryOnFailure) continue;
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  return result;
}

/**
 * Benchmark multiple models with controlled concurrency.
 *
 * Models are tested in batches to avoid overwhelming providers' rate limits.
 *
 * @param models Models to benchmark
 * @param configFactory Function to build per-model benchmark config
 * @param concurrency Max parallel probes. Default: 3
 * @returns Array of BenchmarkResult sorted by TTFT (fastest first)
 */
export async function benchmarkModels(
  models: PlatformModel[],
  configFactory: (model: PlatformModel) => BenchmarkConfig | null,
  concurrency = 3
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const queue = [...models];

  async function worker() {
    while (queue.length > 0) {
      const model = queue.shift()!;
      const config = configFactory(model);

      if (!config) {
        // No API key or config for this provider — skip
        results.push({
          model,
          ttftMs: 0,
          success: false,
          error: 'No API key configured for this provider',
          probedAt: Date.now(),
        });
        continue;
      }

      const result = await benchmarkModel(config);
      // Attach provider info from original model
      result.model = model;
      results.push(result);
    }
  }

  // Launch concurrent workers
  const workers = Array.from(
    { length: Math.min(concurrency, models.length) },
    () => worker()
  );

  await Promise.all(workers);

  // Sort by TTFT: successful probes first (ascending), failures at end
  return results.sort((a, b) => {
    if (a.success && b.success) return a.ttftMs - b.ttftMs;
    if (a.success) return -1;
    if (b.success) return 1;
    return 0;
  });
}

/**
 * Derive provider ID from the base URL for display purposes.
 */
function extractProviderId(baseUrl: string): string {
  if (baseUrl.includes('openrouter')) return 'openrouter';
  if (baseUrl.includes('groq')) return 'groq';
  if (baseUrl.includes('cerebras')) return 'cerebras';
  if (baseUrl.includes('mistral')) return 'mistral';
  if (baseUrl.includes('googleapis') || baseUrl.includes('generativelanguage')) return 'google';
  if (baseUrl.includes('cohere')) return 'cohere';
  if (baseUrl.includes('nvidia')) return 'nvidia';
  if (baseUrl.includes('cloudflare')) return 'cloudflare';
  return 'unknown';
}
