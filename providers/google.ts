import type { PlatformModel } from '../lib/types.js';

/**
 * Google AI Studio (Gemini API) platform adapter.
 *
 * API: https://generativelanguage.googleapis.com/v1beta
 * Auth: query param ?key=API_KEY
 * Free models: gemini-2.5-flash, gemini-2.5-pro, gemma-3 variants
 * Limits: 250K TPM, 5-15 RPM, 100-1K requests/day
 */

export interface GoogleConfig {
  apiKey: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Known free-tier models — used as fallback if models.list fails
const KNOWN_FREE_MODELS = [
  { modelId: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', contextLength: 1_048_576 },
  { modelId: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', contextLength: 1_048_576 },
  { modelId: 'gemma-3-12b-it', displayName: 'Gemma 3 12B', contextLength: 32_768 },
  { modelId: 'gemma-3-27b-it', displayName: 'Gemma 3 27B', contextLength: 32_768 },
];

/**
 * Discover available models from Google AI Studio and filter free-tier ones.
 *
 * Google's free tier is per-account (no pricing field in the API),
 * so we use a curated list of known free models + any model with
 * inputTokenLimit > 0 and no paidOnly flag.
 */
export async function discoverFreeModels(
  config: GoogleConfig
): Promise<PlatformModel[]> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}/models?key=${config.apiKey}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      // Fallback to curated list on API error
      return buildModelsFromKnown();
    }

    const json = await res.json();
    const models: PlatformModel[] = [];

    for (const gm of json.models ?? []) {
      if (!isFreeTierModel(gm)) continue;

      models.push({
        providerId: 'google',
        modelId: gm.baseModelId ?? gm.name?.replace('models/', ''),
        displayName: gm.displayName ?? gm.name,
        contextLength: gm.inputTokenLimit ?? 0,
        isFree: true,
        pricing: { prompt: 0, completion: 0 },
        modality: detectModality(gm),
        discoveredAt: Date.now(),
      });
    }

    return models.length > 0 ? models : buildModelsFromKnown();
  } catch {
    return buildModelsFromKnown();
  }
}

/**
 * Check if a Google model is available on the free tier.
 * Google doesn't expose pricing in the models API, so we check:
 *  - Model name matches known free pattern
 *  - Has valid input token limit
 */
function isFreeTierModel(gm: GoogleModel): boolean {
  const name = (gm.baseModelId ?? gm.name ?? '').toLowerCase();

  // Free tier models follow known patterns
  const freePatterns = [
    'gemini-2.5-flash', 'gemini-2.5-pro',
    'gemma-3', 'gemma-2',
    'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro',
  ];

  return freePatterns.some(p => name.includes(p)) && gm.inputTokenLimit > 0;
}

function detectModality(gm: GoogleModel): string {
  const supported = gm.supportedGenerationMethods ?? [];
  if (supported.includes('generateContent') || supported.includes('streamGenerateContent')) {
    // Check for vision/audio support
    const name = (gm.baseModelId ?? '').toLowerCase();
    if (name.includes('vision') || name.includes('flash')) return 'text+image';
    if (name.includes('audio')) return 'text+audio';
    return 'text';
  }
  return 'text';
}

function buildModelsFromKnown(): PlatformModel[] {
  return KNOWN_FREE_MODELS.map((m) => ({
    providerId: 'google',
    modelId: m.modelId,
    displayName: m.displayName,
    contextLength: m.contextLength,
    isFree: true,
    pricing: { prompt: 0, completion: 0 },
    modality: 'text',
    discoveredAt: Date.now(),
  }));
}

interface GoogleModel {
  name: string;
  baseModelId: string;
  version: string;
  displayName: string;
  description: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  supportedGenerationMethods: string[];
}

/**
 * Get the chat completions URL for Google (OpenAI-compatible endpoint).
 * Google AI Studio now supports OpenAI-compatible format at:
 * https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
 */
export function getChatUrl(apiKey: string, baseUrl?: string): string {
  const base = baseUrl ?? DEFAULT_BASE_URL;
  return `${base}/openai/chat/completions?key=${apiKey}`;
}

/**
 * Build benchmark config for a Google model.
 * Google's OpenAI-compatible endpoint uses the model ID directly.
 */
export function buildBenchmarkConfig(
  config: GoogleConfig,
  modelId: string
): { baseUrl: string; apiKey: string; modelId: string } {
  return {
    baseUrl: `${config.baseUrl ?? DEFAULT_BASE_URL}/openai`,
    apiKey: config.apiKey,
    modelId,
  };
}
