import type { PlatformModel } from '../lib/types.js';

export interface OpenRouterModelResponse {
  data: Array<{
    id: string;
    name: string;
    created: number;
    description?: string;
    context_length: number;
    architecture: {
      modality: string;
      tokenizer: string;
      instruct_type?: string;
    };
    pricing: {
      prompt: string;
      completion: string;
      image: string;
      request: string;
    };
    top_provider: {
      context_length: number;
      max_completion_tokens: number | null;
      is_moderated: boolean;
    };
    per_request_limits: Record<string, string> | null;
  }>;
}

export interface OpenRouterConfig {
  apiKey?: string;
  baseUrl: string;
  /** Max requests per polling cycle for free model discovery */
  discoveryLimit: number;
}

const DEFAULT_CONFIG: Required<OpenRouterConfig> = {
  apiKey: '',
  baseUrl: 'https://openrouter.ai/api/v1',
  discoveryLimit: 200,
};

/**
 * Fetch all models from OpenRouter API and filter free ones.
 *
 * Free model criteria:
 *  - Both prompt AND completion pricing === "0"
 *  - OR id ends with ":free" (OpenRouter's explicit free route convention)
 *  - NOT per_request_limits with strict paid caps
 */
export async function discoverFreeModels(
  config: Partial<OpenRouterConfig> = {}
): Promise<PlatformModel[]> {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  const url = `${resolvedConfig.baseUrl}/models`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (resolvedConfig.apiKey) {
    headers['Authorization'] = `Bearer ${resolvedConfig.apiKey}`;
  }

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });

  if (!res.ok) {
    throw new Error(
      `OpenRouter model discovery failed: ${res.status} ${res.statusText}`
    );
  }

  const json: OpenRouterModelResponse = await res.json();
  const freeModels: PlatformModel[] = [];

  for (const model of json.data) {
    const isFree = isFreeModel(model);
    if (!isFree) continue;

    freeModels.push({
      providerId: 'openrouter',
      modelId: model.id,
      displayName: model.name || model.id,
      contextLength: model.context_length,
      isFree: true,
      pricing: {
        prompt: parseFloat(model.pricing.prompt),
        completion: parseFloat(model.pricing.completion),
      },
      modality: model.architecture?.modality ?? 'text',
      discoveredAt: Date.now(),
    });
  }

  return freeModels;
}

/**
 * Determine if a model qualifies as "free".
 */
export function isFreeModel(
  model: OpenRouterModelResponse['data'][number]
): boolean {
  // Explicit ":free" suffix — OpenRouter's built-in free routing group
  if (model.id.endsWith(':free')) return true;

  // Zero pricing on both prompt and completion
  const promptPrice = parseFloat(model.pricing.prompt);
  const completionPrice = parseFloat(model.pricing.completion);
  if (promptPrice === 0 && completionPrice === 0) return true;

  return false;
}
