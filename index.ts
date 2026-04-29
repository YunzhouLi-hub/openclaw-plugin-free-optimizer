import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { createProviderApiKeyAuthMethod } from 'openclaw/plugin-sdk/provider-auth';
import { buildProviderReplayFamilyHooks } from 'openclaw/plugin-sdk/provider-model-shared';

import type { PlatformModel, RankedModel, OptimizerState, BenchmarkResult } from './lib/types.js';
import type { PluginLogger, PluginCommandContext, OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import type {
  ProviderPluginCatalog,
  ProviderPlugin,
  ProviderResolveDynamicModelContext,
  ProviderPrepareDynamicModelContext,
  ProviderRuntimeModel,
  ProviderCatalogResult,
  OpenClawPluginService,
} from './types/openclaw-plugin-sdk.js';
import { buildRegistry, type ProviderCredentials, type ProviderRegistry } from './providers/registry.js';
import { discoverAllProviders } from './providers/registry.js';
import { benchmarkModels, type BenchmarkConfig } from './lib/benchmarker.js';
import { rankModels, getBestModel, getBestFreshModel, getFallbackChain, isBenchmarkStaleButUsable, formatAge, DEFAULT_CACHE_TTL_MS, DEFAULT_STALE_TTL_MS, printRankingTable } from './lib/ranker.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ======================== Constants ========================

const PLUGIN_ID = 'free-optimizer';
const PROVIDER_ID = 'free-opt';
const STATE_FILE = 'free-optimizer-state.json';
const OPENAI_COMPAT_REPLAY_HOOKS = buildProviderReplayFamilyHooks({ family: 'openai-compatible' }) as Record<string, unknown>;
const __pluginDir = dirname(fileURLToPath(import.meta.url));

// ======================== Plugin Entry ========================

export default definePluginEntry({
  id: PLUGIN_ID,
  name: 'Free Optimizer',
  description: 'Auto-discover, benchmark, and dynamically route to the fastest free LLM across multiple providers.',

  register(api: OpenClawPluginApi) {
    const logger = api.logger;

    // ======================== 1. Register the virtual provider ========================

    const provider: ProviderPlugin = {
      id: PROVIDER_ID,
      label: 'Free Optimizer (Auto-Routing)',
      docsPath: '/plugins/free-optimizer',
      envVars: ['FREE_OPT_OPENROUTER_KEY', 'FREE_OPT_GOOGLE_KEY', 'FREE_OPT_GROQ_KEY'],

      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: 'api-key',
          label: 'Free Optimizer API keys',
          hint: 'Configure provider keys in config.json',
          optionKey: 'freeOptimizerApiKey',
          flagName: '--free-opt-key',
          envVar: 'FREE_OPT_API_KEY',
          promptMessage: 'Enter your Free Optimizer config path',
          defaultModel: 'free-opt/auto',
        }),
      ],

      // Live catalog — runs network I/O to discover free models
      catalog: {
        order: 'simple',
        run: async (): Promise<ProviderCatalogResult> => {
          const creds = loadCredentialsFromConfig();
          const registry = buildRegistry(creds);
          const models = await discoverAllProviders(registry);

          return {
            provider: {
              baseUrl: 'https://openrouter.ai/api/v1',
              apiKey: creds.openrouter?.apiKey ?? '',
              api: 'openai-completions',
              models: models.length > 0
                ? models.map(toCatalogModel)
                : [defaultAutoModel()],
            },
          };
        },
      } satisfies ProviderPluginCatalog,

      // Static catalog — no I/O, for setup surfaces
      staticCatalog: {
        order: 'simple',
        run: async (): Promise<ProviderCatalogResult> => ({
          provider: {
            api: 'openai-completions',
            baseUrl: 'https://openrouter.ai/api/v1',
            models: [defaultAutoModel()],
          },
        }),
      } satisfies ProviderPluginCatalog,

      resolveDynamicModel: (_ctx: ProviderResolveDynamicModelContext): ProviderRuntimeModel | null | undefined => {
        const state = loadOptimizerStateSync();
        const now = Date.now();

        // Priority 1: Best fresh model (benchmarked within cache TTL)
        const ranked = buildRankedList(state);
        const fresh = getBestFreshModel(ranked, now);
        if (fresh) {
          const endpoint = getProviderEndpoint(fresh);
          return {
            id: fresh.model.modelId,
            name: `${fresh.model.providerId}/${fresh.model.modelId} (${fresh.ttftMs}ms)`,
            provider: fresh.model.providerId,
            api: 'openai-completions',
            baseUrl: endpoint.baseUrl,
            reasoning: false,
            input: fresh.model.modality.includes('image')
              ? ['text', 'image']
              : ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: fresh.model.contextLength,
            maxTokens: Math.min(Math.floor(fresh.model.contextLength * 0.5), 8192),
          };
        }

        // Priority 2: Fallback chain — best stale model, then secondary
        const { primary, fallback } = getFallbackChain(ranked);
        const candidate = primary ?? fallback;
        if (candidate) {
          const stale = primary ? '' : ' (stale fallback)';
          const endpoint = getProviderEndpoint(candidate);
          return {
            id: candidate.model.modelId,
            name: `${candidate.model.providerId}/${candidate.model.modelId}${stale}`,
            provider: candidate.model.providerId,
            api: 'openai-completions',
            baseUrl: endpoint.baseUrl,
            reasoning: false,
            input: candidate.model.modality.includes('image')
              ? ['text', 'image']
              : ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: candidate.model.contextLength,
            maxTokens: Math.min(Math.floor(candidate.model.contextLength * 0.5), 8192),
          };
        }

        // Priority 3: OpenRouter free fallback
        return {
          id: 'openrouter/free',
          name: 'OpenRouter Free (fallback)',
          provider: 'openrouter',
          api: 'openai-completions',
          baseUrl: 'https://openrouter.ai/api/v1',
          reasoning: false,
          input: ['text'] as Array<'text' | 'image' | 'video' | 'audio'>,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 4096,
        };
      },

      prepareDynamicModel: async (_ctx: ProviderPrepareDynamicModelContext): Promise<void> => {
        // Only refresh benchmark state from the "async" path;
        // the sync resolveDynamicModel path handles cache + fallback.
        const state = loadOptimizerStateSync();
        const ranked = buildRankedList(state);
        const now = Date.now();
        const config = loadBenchmarkConfig();

        // If best model is still fresh, skip re-benchmark
        const bestFresh = getBestFreshModel(ranked, now, DEFAULT_CACHE_TTL_MS);
        if (bestFresh) {
          logger.info(`[free-optimizer] Cache hit: ${bestFresh.model.providerId}/${bestFresh.model.modelId} (${bestFresh.ttftMs}ms, ${formatAge(Date.now() - bestFresh.probedAt)} old)`);
          return;
        }

        // Only full re-benchmark ahead of schedule if best model is stale
        // and the regular benchmark cycle is more than 30s away
        const bestOverall = getBestModel(ranked);
        if (bestOverall && isBenchmarkStaleButUsable(bestOverall, now, DEFAULT_STALE_TTL_MS)) {
          // Stale but usable — let the regular cycle handle it unless urgent
          logger.info('[free-optimizer] Best model stale but usable, skipping re-benchmark');
          return;
        }

        logger.info('[free-optimizer] No fresh benchmark, running re-benchmark...');
        await runBenchmarkCycle(logger);
      },

      ...OPENAI_COMPAT_REPLAY_HOOKS,
    };

    api.registerProvider(provider as any);

    // ======================== 2. Register benchmark service ========================

    api.registerService({
      id: `${PLUGIN_ID}:benchmark`,
      start: async () => {
        const config = loadBenchmarkConfig();
        if (!config.enabled) return;

        await runBenchmarkCycle(logger);

        const interval = setInterval(
          () => { runBenchmarkCycle(logger).catch(e => {
            const msg = e instanceof Error ? e.message : String(e);
            logger.info('[free-optimizer] benchmark cycle failed: ' + msg);
          }); },
          config.intervalMinutes * 60 * 1000
        );

        (globalThis as Record<string, unknown>)[`__free_opt_interval_${PLUGIN_ID}`] = interval;

        logger.info(`[free-optimizer] Benchmark service started. Interval: ${config.intervalMinutes}min`);
      },
      stop: async () => {
        const key = `__free_opt_interval_${PLUGIN_ID}`;
        const interval = (globalThis as Record<string, unknown>)[key] as ReturnType<typeof setInterval> | undefined;
        if (interval) {
          clearInterval(interval);
          delete (globalThis as Record<string, unknown>)[key];
        }
      },
    } satisfies OpenClawPluginService);

    // ======================== 3. Register CLI commands ========================

    api.registerCommand({
      name: 'free-opt_status',
      description: 'Show current model ranking and active route',
      handler: async (_ctx: PluginCommandContext): Promise<{ text: string }> => {
        const state = loadOptimizerStateSync();
        const ranked = buildRankedList(state);

        if (ranked.length === 0) {
          return { text: 'No models benchmarked yet. Run "free-opt:test" to start.' };
        }

        printRankingTable(ranked);

        const best = getBestModel(ranked);
        const msg = best
          ? `Active route: ${best.model.providerId}/${best.model.modelId} (${best.ttftMs}ms)`
          : 'No model passed benchmark. Fallback to OpenRouter free route.';

        return { text: msg };
      },
    });

    api.registerCommand({
      name: 'free-opt_test',
      description: 'Run an immediate benchmark cycle',
      handler: async (_ctx: PluginCommandContext): Promise<{ text: string }> => {
        await runBenchmarkCycle(logger);

        const state = loadOptimizerStateSync();
        const ranked = buildRankedList(state);

        if (ranked.length === 0) {
          return { text: 'No models found. Check your API keys in config.json.' };
        }

        printRankingTable(ranked);

        const best = getBestModel(ranked);
        const msg = best
          ? `Best model: ${best.model.providerId}/${best.model.modelId} (${best.ttftMs}ms) — routing active`
          : 'All models failed benchmark.';

        return { text: msg };
      },
    });

    api.registerCommand({
      name: 'free-opt_health',
      description: 'Quick health check — only tests the currently active model',
      handler: async (_ctx: PluginCommandContext): Promise<{ text: string }> => {
        const state = loadOptimizerStateSync();
        const ranked = buildRankedList(state);
        const active = getBestModel(ranked);

        if (!active) {
          return { text: 'No active model. Run "free-opt_test" first to establish a route.' };
        }

        const creds = loadCredentialsFromConfig();
        const providerCreds = creds[active.model.providerId as keyof ProviderCredentials];
        if (!providerCreds?.apiKey) {
          return { text: `Active model ${active.model.providerId}/${active.model.modelId} has no API key configured.` };
        }

        const result = await quickHealthCheck(active, providerCreds, logger);

        if (result.alive) {
          return {
            text: `✅ ${active.model.providerId}/${active.model.modelId} is alive. TTFT: ${result.ttftMs}ms`
              + (result.qualityScore != null ? ` (quality: ${result.qualityScore}/5)` : ''),
          };
        }

        // Active model is dead — trigger a full re-benchmark
        logger.info(`[free-optimizer] Active model ${active.model.providerId}/${active.model.modelId} dead (${result.error}). Running re-benchmark...`);
        await runBenchmarkCycle(logger);

        const newState = loadOptimizerStateSync();
        const newRanked = buildRankedList(newState);
        const newBest = getBestModel(newRanked);

        if (newBest) {
          return {
            text: `❌ ${active.model.providerId}/${active.model.modelId} dead (${result.error}). Auto-switched to ${newBest.model.providerId}/${newBest.model.modelId} (${newBest.ttftMs}ms).`
          };
        }

        return { text: `❌ ${active.model.providerId}/${active.model.modelId} dead (${result.error}). No healthy fallback found.` };
      },
    });

    api.registerCommand({
      name: 'free-opt_list',
      description: 'List all discovered models, their benchmark status, and current filter',
      handler: async (_ctx: PluginCommandContext): Promise<{ text: string }> => {
        const creds = loadCredentialsFromConfig();
        const registry = buildRegistry(creds);
        const config = loadBenchmarkConfig();

        const models = await discoverAllProviders(registry);
        if (models.length === 0) {
          return { text: 'No free models discovered. Check your API keys.' };
        }

        const state = loadOptimizerStateSync();
        const byProvider = new Map<string, PlatformModel[]>();
        for (const m of models) {
          if (!byProvider.has(m.providerId)) byProvider.set(m.providerId, []);
          byProvider.get(m.providerId)!.push(m);
        }

        const filtered = filterModels(models, config);
        const filteredSet = new Set(filtered.map(m => `${m.providerId}/${m.modelId}`));

        const lines: string[] = [
          `Discovered ${models.length} free models across ${byProvider.size} providers.`,
        ];

        if (config.includeModels.length > 0) {
          lines.push(`  Include filter: ${config.includeModels.join(', ')}`);
        }
        if (config.excludeModels.length > 0) {
          lines.push(`  Exclude filter: ${config.excludeModels.join(', ')}`);
        }
        if (config.includeProviders.length > 0) {
          lines.push(`  Include providers: ${config.includeProviders.join(', ')}`);
        }
        if (config.excludeProviders.length > 0) {
          lines.push(`  Exclude providers: ${config.excludeProviders.join(', ')}`);
        }
        if (config.minParamB > 0) {
          lines.push(`  Min model size: ${config.minParamB}B+ (parsed from model name)`);
        }
        if (config.minContextTokens > 0) {
          lines.push(`  Min context: ${(config.minContextTokens / 1000).toFixed(0)}k+ tokens`);
        }
        if (config.pinnedModel) {
          lines.push(`  Pinned model: ${config.pinnedModel} (benchmark skipped)`);
        }
        if (config.preferredModels.length > 0) {
          lines.push(`  Preferred: ${config.preferredModels.join(', ')} (⭐)`);
        }
        if (config.avoidModels.length > 0) {
          lines.push(`  Avoid: ${config.avoidModels.join(', ')} (🚫)`);
        }
        lines.push(`  After filter: ${filtered.length} models will be benchmarked\n`);

        for (const [provider, providerModels] of byProvider) {
          lines.push(`  ${provider} (${providerModels.length} models):`);
          for (const m of providerModels) {
            const key = `${m.providerId}/${m.modelId}`;
            const ctx = m.contextLength > 0 ? ` [ctx: ${(m.contextLength / 1000).toFixed(0)}k]` : '';
            const bench = state.benchmarks[key];
            const status = bench?.success
              ? ` ✓ ${bench.ttftMs}ms`
              : bench
                ? ` ✗`
                : ' —';
            const excluded = filteredSet.has(key) ? '' : ' [excluded]';
            lines.push(`    ${key}${ctx}${status}${excluded}`);
          }
          lines.push('');
        }

        // Print to console for full output
        console.log(lines.join('\n'));
        return { text: lines.slice(0, 8).join('\n') + `\n  ... and ${models.length} total models (see console for full list)` };
      },
    });

    api.registerCommand({
      name: 'free-opt_discover',
      description: 'Discover and list all available free models',
      handler: async (_ctx: PluginCommandContext): Promise<{ text: string }> => {
        const creds = loadCredentialsFromConfig();
        const registry = buildRegistry(creds);

        const models = await discoverAllProviders(registry);

        if (models.length === 0) {
          return { text: 'No free models discovered. Check your API keys.' };
        }

        const byProvider = new Map<string, PlatformModel[]>();
        for (const m of models) {
          if (!byProvider.has(m.providerId)) byProvider.set(m.providerId, []);
          byProvider.get(m.providerId)!.push(m);
        }

        const lines: string[] = [`Found ${models.length} free models across ${byProvider.size} providers:\n`];
        for (const [provider, providerModels] of byProvider) {
          lines.push(`  ${provider} (${providerModels.length} models):`);
          for (const m of providerModels) {
            const ctx = m.contextLength > 0 ? ` [ctx: ${m.contextLength.toLocaleString()}]` : '';
            lines.push(`    - ${m.modelId}${ctx}`);
          }
          lines.push('');
        }

        // Print to console for TUI, return first lines as reply
        console.log(lines.join('\n'));
        return { text: lines.slice(0, 3).join('\n') + `\n  ... and ${models.length} total models (see full list in console)` };
      },
    });
  },
});

// ======================== Benchmark Cycle ========================

/**
 * Filter models based on user's include/exclude lists.
 * - includeModels: if non-empty, ONLY these model IDs are allowed
 * - excludeModels: if non-empty, these model IDs are removed
 * Matching is case-insensitive and matches against `${providerId}/${modelId}`
 */
export interface ModelFilter {
  /** Only benchmark models whose providerId/modelId includes any of these strings */
  includeModels: string[];
  /** Exclude models whose providerId/modelId includes any of these strings */
  excludeModels: string[];
  /** Only benchmark models from these providers. Empty = all providers. Matches against providerId. */
  includeProviders: string[];
  /** Exclude models from these providers. Matches against providerId. */
  excludeProviders: string[];
  /** Minimum model parameters in billions (e.g. 7 = 7B+). Parsed from model name. */
  minParamB: number;
  /** Minimum context window in tokens (e.g. 32000 = 32k+). */
  minContextTokens: number;
}

/**
 * Try to extract parameter count (in billions) from a model name string.
 * Examples:
 *   "llama-3.3-70b-instruct"      → 70
 *   "nemotron-3-nano-30b-a3b"     → 30
 *   "gpt-oss-120b"                → 120
 *   "gemma-4-26b-a4b-it"         → 26
 *   "qwen3-coder"                → 0 (unknown)
 *   "gemini-2.5-flash"           → 0 (unknown, estimated by provider)
 */
export function extractParamB(modelId: string): number {
  // Match patterns like 70b, 120b, 1.2b, 235b-a22b (take the first full number before 'b')
  const match = modelId.match(/(\d+(?:\.\d+)?)b/i);
  if (match) {
    return parseFloat(match[1]);
  }
  return 0;
}

/**
 * Filter models based on user' include/exclude lists + parameter size + context length.
 */
export function filterModels(
  models: PlatformModel[],
  filter: ModelFilter
): PlatformModel[] {
  let filtered = models;

  // 1. Include filter: if non-empty, only keep models matching at least one include pattern
  if (filter.includeModels.length > 0) {
    const lower = filter.includeModels.map(s => s.toLowerCase());
    filtered = filtered.filter(m => {
      const key = `${m.providerId}/${m.modelId}`.toLowerCase();
      return lower.some(inc => key.includes(inc));
    });
  }

  // 2. Exclude filter: remove models matching any exclude pattern
  if (filter.excludeModels.length > 0) {
    const lower = filter.excludeModels.map(s => s.toLowerCase());
    filtered = filtered.filter(m => {
      const key = `${m.providerId}/${m.modelId}`.toLowerCase();
      return !lower.some(ex => key.includes(ex));
    });
  }

  // 3. Include providers: if non-empty, only keep models from these providers
  if (filter.includeProviders.length > 0) {
    const lower = filter.includeProviders.map(s => s.toLowerCase());
    filtered = filtered.filter(m => lower.includes(m.providerId.toLowerCase()));
  }

  // 4. Exclude providers: remove models from these providers
  if (filter.excludeProviders.length > 0) {
    const lower = filter.excludeProviders.map(s => s.toLowerCase());
    filtered = filtered.filter(m => !lower.includes(m.providerId.toLowerCase()));
  }

  // 5. Minimum parameter count (from model name)
  if (filter.minParamB > 0) {
    filtered = filtered.filter(m => {
      const paramB = extractParamB(m.modelId);
      return paramB === 0 || paramB >= filter.minParamB;
    });
  }

  // 6. Minimum context window
  if (filter.minContextTokens > 0) {
    filtered = filtered.filter(m => m.contextLength >= filter.minContextTokens);
  }

  return filtered;
}

/**
 * Resolve a pinned model config to a synthetic benchmark result.
 * Format: "providerId/modelId" (e.g. "nvidia/meta/llama-3.3-70b-instruct")
 * Returns null if the model can't be found or no API key for its provider.
 */
async function resolvePinnedModel(
  pinned: string,
  creds: ProviderCredentials,
  registry: ProviderRegistry
): Promise<{ model: PlatformModel; benchmark: BenchmarkResult; ranked: RankedModel } | null> {
  const allModels = await discoverAllProviders(registry);
  const matched = allModels.find(m => `${m.providerId}/${m.modelId}` === pinned);
  if (!matched) return null;

  const providerCreds = creds[matched.providerId as keyof ProviderCredentials];
  if (!providerCreds?.apiKey) return null;

  const benchmark: BenchmarkResult = {
    model: matched,
    ttftMs: 0,
    success: true,
    probedAt: Date.now(),
  };

  const ranked: RankedModel = {
    model: matched,
    ttftMs: 0,
    success: true,
    probedAt: Date.now(),
    rank: 1,
  };

  return { model: matched, benchmark, ranked };
}

/**
 * Quick health check: test a single model for liveness.
 * Returns as soon as first token arrives (like benchmarkModel but lighter).
 * Used by free-opt_health command.
 */
async function quickHealthCheck(
  active: RankedModel,
  providerCreds: Record<string, string>,
  logger: PluginLogger
): Promise<{ alive: boolean; ttftMs: number; qualityScore?: number; error?: string }> {
  const config = loadBenchmarkConfig();
  const endpoints: Record<string, string> = {
    openrouter: 'https://openrouter.ai/api/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai',
    groq: 'https://api.groq.com/openai/v1',
    cerebras: 'https://api.cerebras.ai/v1',
    mistral: 'https://api.mistral.ai/v1',
    nvidia: 'https://integrate.api.nvidia.com/v1',
    github: 'https://models.inference.ai.azure.com',
  };

  const providerId = active.model.providerId;

  // Cloudflare has its own API format
  if (providerId === 'cloudflare') {
    try {
      const start = performance.now();
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${providerCreds.accountId}/ai/run/${active.model.modelId}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${providerCreds.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messages: [{ role: 'user', content: config.prompt }],
            max_tokens: 5,
          }),
          signal: AbortSignal.timeout(config.maxResponseTimeMs),
        }
      );
      if (res.ok) {
        const data = await res.json();
        const responseText = data?.result?.response ?? '';
        const qs = (await import('./lib/benchmarker.js')).scoreResponseQuality(config.prompt, responseText);
        return { alive: true, ttftMs: Math.round(performance.now() - start), qualityScore: qs };
      }
      return { alive: false, ttftMs: Math.round(performance.now() - start), error: `HTTP ${res.status}` };
    } catch (err: unknown) {
      return { alive: false, ttftMs: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // OpenAI-compatible providers
  const baseUrl = endpoints[providerId] ?? endpoints.openrouter;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.maxResponseTimeMs);
    const startTime = performance.now();

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${providerCreds.apiKey}`,
      },
      body: JSON.stringify({
        model: active.model.modelId,
        messages: [{ role: 'user', content: config.prompt }],
        max_tokens: 5,
        stream: true,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return { alive: false, ttftMs: Math.round(performance.now() - startTime), error: `HTTP ${res.status}` };
    }

    if (!res.body) {
      return { alive: false, ttftMs: Math.round(performance.now() - startTime), error: 'No body' };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let gotFirstToken = false;
    let ttftMs = 0;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') break;
        try {
          const data = JSON.parse(dataStr);
          const content = data.choices?.[0]?.delta?.content ?? '';
          if (content) {
            if (!gotFirstToken) {
              gotFirstToken = true;
              ttftMs = Math.round(performance.now() - startTime);
            }
            fullResponse += content;
          }
        } catch { /* skip */ }
      }
    }

    if (!gotFirstToken) {
      return { alive: false, ttftMs: Math.round(performance.now() - startTime), error: 'No tokens' };
    }

    return {
      alive: true,
      ttftMs: ttftMs || Math.round(performance.now() - startTime),
      qualityScore: (await import('./lib/benchmarker.js')).scoreResponseQuality(config.prompt, fullResponse),
    };
  } catch (err: unknown) {
    const error = err instanceof Error && err.name === 'AbortError'
      ? `Timeout after ${config.maxResponseTimeMs}ms`
      : (err instanceof Error ? err.message : String(err));
    return { alive: false, ttftMs: 0, error };
  }
}

async function runBenchmarkCycle(logger: PluginLogger): Promise<void> {
  const creds = loadCredentialsFromConfig();
  const registry = buildRegistry(creds);
  const config = loadBenchmarkConfig();

  // Pinned model: if configured, skip benchmark entirely and use it directly
  if (config.pinnedModel) {
    const pinned = await resolvePinnedModel(config.pinnedModel, creds, registry);
    if (pinned) {
      logger.info(`[free-optimizer] Pinned model: ${config.pinnedModel} — skipping benchmark`);
      const state = buildOptimizerState([pinned.model], [pinned.benchmark], [pinned.ranked]);
      saveOptimizerStateSync(state);
      return;
    }
    logger.warn(`[free-optimizer] Pinned model "${config.pinnedModel}" not found or no API key. Falling through to benchmark.`);
  }

  const allModels = await discoverAllProviders(registry);
  if (allModels.length === 0) {
    logger.info('[free-optimizer] No free models discovered.');
    return;
  }

  // Apply user model filters
  const filtered = filterModels(allModels, config);
  if (filtered.length === 0) {
    logger.info('[free-optimizer] All models filtered out. Check include/exclude config.');
    return;
  }
  if (filtered.length < allModels.length) {
    logger.info(`[free-optimizer] Filtered: ${allModels.length} → ${filtered.length} models (${filtered.length === 0 ? 'none left' : 'using ' + filtered.length})`);
  }

  const endpoints: Record<string, string> = {
    openrouter: 'https://openrouter.ai/api/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai',
    groq: 'https://api.groq.com/openai/v1',
    cerebras: 'https://api.cerebras.ai/v1',
    mistral: 'https://api.mistral.ai/v1',
    nvidia: 'https://integrate.api.nvidia.com/v1',
    github: 'https://models.inference.ai.azure.com',
  };

  const results = await benchmarkModels(
    filtered,
    (model): BenchmarkConfig | null => {
      const creds = loadCredentialsFromConfig();
      const providerCreds = creds[model.providerId as keyof ProviderCredentials];
      if (!providerCreds?.apiKey) return null;

      // Cloudflare uses non-OpenAI API — skip through benchmarker, use direct proxy
      if (model.providerId === 'cloudflare') {
        return null;
      }

      return {
        apiKey: providerCreds.apiKey,
        baseUrl: endpoints[model.providerId] ?? endpoints.openrouter,
        modelId: model.modelId,
        maxResponseTime: config.maxResponseTimeMs,
        prompt: config.prompt,
        maxTokens: config.maxTokens,
        retryOnFailure: config.retryOnFailure,
        retryDelayMs: config.retryDelayMs,
      };
    },
    config.concurrency
  );

  // Cloudflare uses its own API format — benchmark separately
  const cfModels = filtered.filter(m => m.providerId === 'cloudflare');
  for (const cfModel of cfModels) {
    const cfCreds = creds.cloudflare;
    if (!cfCreds?.apiKey || !cfCreds.accountId) continue;

    try {
      const start = performance.now();
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfCreds.accountId}/ai/run/${cfModel.modelId}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfCreds.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messages: [{ role: 'user', content: config.prompt }],
            max_tokens: config.maxTokens,
          }),
          signal: AbortSignal.timeout(config.maxResponseTimeMs),
        }
      );

      if (res.ok) {
        const ttft = Math.round(performance.now() - start);
        results.push({
          model: cfModel,
          ttftMs: ttft,
          success: true,
          probedAt: Date.now(),
        });
      } else {
        results.push({
          model: cfModel,
          ttftMs: Math.round(performance.now() - start),
          success: false,
          error: `HTTP ${res.status}`,
          probedAt: Date.now(),
        });
      }
    } catch (err: unknown) {
      results.push({
        model: cfModel,
        ttftMs: 0,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        probedAt: Date.now(),
      });
    }
  }

  const ranked = rankModels(filtered, results);
  const state = buildOptimizerState(filtered, results, ranked);
  saveOptimizerStateSync(state);

  const best = getBestModel(ranked);
  if (best) {
    logger.info(
      `[free-optimizer] Best model: ${best.model.providerId}/${best.model.modelId} (${best.ttftMs}ms TTFT) — routing active`
    );
  } else {
    logger.info('[free-optimizer] No model passed benchmark. Fallback to OpenRouter free route.');
  }
}

// ======================== State Management ========================

function getStateDir(): string {
  const home = process.env.OPENCLAW_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return join(home, '.openclaw', 'plugins', 'free-optimizer');
}

function getStatePath(): string {
  return join(getStateDir(), STATE_FILE);
}

const EMPTY_STATE: OptimizerState = {
  models: {},
  benchmarks: {},
  lastDiscoveryAt: {},
  activeModel: null,
};

function loadOptimizerStateSync(): OptimizerState {
  try {
    if (!existsSync(getStatePath())) return { ...EMPTY_STATE };
    const raw = readFileSync(getStatePath(), 'utf8');
    return JSON.parse(raw) as OptimizerState;
  } catch {
    return { ...EMPTY_STATE };
  }
}

function saveOptimizerStateSync(state: OptimizerState): void {
  const dir = getStateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getStatePath(), JSON.stringify(state, null, 2), 'utf8');
}

function buildOptimizerState(
  models: PlatformModel[],
  results: BenchmarkResult[],
  ranked: RankedModel[]
): OptimizerState {
  const state: OptimizerState = { models: {}, benchmarks: {}, lastDiscoveryAt: {}, activeModel: null };

  for (const m of models) {
    state.models[`${m.providerId}/${m.modelId}`] = m;
  }

  for (const r of results) {
    const key = `${r.model.providerId}/${r.model.modelId}`;
    state.benchmarks[key] = r;
    state.lastDiscoveryAt[r.model.providerId] = r.probedAt;
  }

  const best = ranked.find(r => r.success && r.rank === 1);
  if (best) {
    state.activeModel = `${best.model.providerId}/${best.model.modelId}`;
  }

  return state;
}

function buildRankedList(state: OptimizerState): RankedModel[] {
  const config = loadBenchmarkConfig();
  return rankModels(
    Object.values(state.models),
    Object.values(state.benchmarks),
    config.preferredModels,
    config.avoidModels
  );
}

function getProviderEndpoint(model: RankedModel): { baseUrl: string; apiKey: string } {
  const creds = loadCredentialsFromConfig();

  const endpoints: Record<string, string> = {
    openrouter: 'https://openrouter.ai/api/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai',
    groq: 'https://api.groq.com/openai/v1',
    cerebras: 'https://api.cerebras.ai/v1',
    mistral: 'https://api.mistral.ai/v1',
    nvidia: 'https://integrate.api.nvidia.com/v1',
    cloudflare: 'https://api.cloudflare.com/client/v4/accounts',
    github: 'https://models.inference.ai.azure.com',
  };

  return {
    baseUrl: endpoints[model.model.providerId] ?? endpoints.openrouter,
    apiKey: creds[model.model.providerId as keyof ProviderCredentials]?.apiKey ?? '',
  };
}

// ======================== Config Loading ========================

function loadCredentialsFromConfig(): ProviderCredentials {
  const creds: ProviderCredentials = {};

  const configPath = join(__pluginDir, 'config.json');
  try {
    const raw = readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);

    for (const [key, val] of Object.entries(config.apiKeys ?? {})) {
      const entry = val as Record<string, unknown>;
      if (entry?.enabled && entry?.apiKey) {
        const v: Record<string, string> = { apiKey: entry.apiKey as string };
        if (entry.accountId) v.accountId = entry.accountId as string;
        (creds as Record<string, Record<string, string>>)[key] = v;
      }
    }
  } catch { /* config file not found or invalid */ }

  // Env var overrides
  const envMap: Record<string, [string, string?]> = {
    openrouter: ['FREE_OPT_OPENROUTER_KEY'],
    google: ['FREE_OPT_GOOGLE_KEY'],
    groq: ['FREE_OPT_GROQ_KEY'],
    cerebras: ['FREE_OPT_CEREBRAS_KEY'],
    mistral: ['FREE_OPT_MISTRAL_KEY'],
    nvidia: ['FREE_OPT_NVIDIA_KEY'],
    cloudflare: ['FREE_OPT_CLOUDFLARE_KEY', 'FREE_OPT_CLOUDFLARE_ACCOUNT_ID'],
    github: ['FREE_OPT_GITHUB_KEY'],
    huggingface: ['FREE_OPT_HUGGINGFACE_KEY'],
  };

  for (const [provider, [keyVar, acctVar]] of Object.entries(envMap)) {
    const key = process.env[keyVar];
    if (key) {
      const v: Record<string, string> = { apiKey: key };
      if (acctVar && process.env[acctVar]) {
        v.accountId = process.env[acctVar]!;
      }
      (creds as Record<string, Record<string, string>>)[provider] = v;
    }
  }

  return creds;
}



interface BenchmarkConfigRead extends ModelFilter {
  enabled: boolean;
  intervalMinutes: number;
  maxResponseTimeMs: number;
  concurrency: number;
  prompt: string;
  maxTokens: number;
  retryOnFailure: number;
  retryDelayMs: number;
  minParamB: number;
  minContextTokens: number;
  /** Pin to a specific model. Format: "providerId/modelId". Skip benchmark, always use this. */
  pinnedModel: string;
  /** Models to prefer in ranking (format: "providerId/modelId"). These rank above others regardless of TTFT. */
  preferredModels: string[];
  /** Models to avoid in ranking (format: "providerId/modelId"). These rank below equal-speed models. */
  avoidModels: string[];
  /** Enable quick health check before selecting active model */
  healthCheckEnabled: boolean;
  /** How often (ms) to run health checks on the active model */
  healthCheckIntervalMs: number;
}

function loadBenchmarkConfig(): BenchmarkConfigRead {
  const defaults: BenchmarkConfigRead = {
    enabled: true,
    intervalMinutes: 60,
    maxResponseTimeMs: 15_000,
    concurrency: 3,
    prompt: 'What is the capital of France? Reply in one word.',
    maxTokens: 10,
    retryOnFailure: 2,
    retryDelayMs: 3_000,
    includeModels: [],
    excludeModels: [],
    includeProviders: [],
    excludeProviders: [],
    minParamB: 0,
    minContextTokens: 0,
    pinnedModel: '',
    preferredModels: [],
    avoidModels: [],
    healthCheckEnabled: true,
    healthCheckIntervalMs: 30_000,
  };

  const configPath = join(__pluginDir, 'config.json');
  try {
    const raw = readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    const bench = config.benchmark ?? {};
    return { ...defaults, ...bench };
  } catch {
    return defaults;
  }
}

// ======================== Catalog Helpers ========================

type ModelInput = 'text' | 'image' | 'video' | 'audio';

function toCatalogModel(m: PlatformModel) {
  const input: ModelInput[] = m.modality.includes('image') ? ['text', 'image'] : ['text'];
  return {
    id: m.modelId,
    name: m.displayName,
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextLength,
    maxTokens: Math.min(Math.floor(m.contextLength * 0.5), 8192),
  };
}

function defaultAutoModel() {
  return {
    id: 'auto',
    name: 'Auto (Fastest Free Model)',
    reasoning: false,
    input: ['text', 'image'] as ModelInput[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
}
