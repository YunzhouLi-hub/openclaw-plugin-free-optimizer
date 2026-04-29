import type { PlatformModel } from '../lib/types.js';

/**
 * OpenAI-compatible API adapter.
 *
 * Works with any provider that implements the /v1/models endpoint:
 * Groq, Cerebras, Mistral, NVIDIA NIM, Cloudflare, GitHub Models, etc.
 */

export interface OpenAICompatibleConfig {
  /** Provider identifier, e.g. 'groq', 'cerebras' */
  providerId: string;
  /** API key */
  apiKey: string;
  /** Base URL, e.g. 'https://api.groq.com/openai/v1' */
  baseUrl: string;
  /** Optional: pre-defined list of free model IDs to use instead of API discovery */
  knownFreeModels?: Array<{ modelId: string; displayName: string; contextLength: number }>;
}

/**
 * Discover models from an OpenAI-compatible /v1/models endpoint.
 *
 * Since most providers don't expose pricing in the models API,
 * we either:
 *  1. Use a curated `knownFreeModels` list (recommended for precision)
 *  2. Return ALL models and let the caller filter (risk of including paid models)
 */
export async function discoverFreeModels(
  config: OpenAICompatibleConfig
): Promise<PlatformModel[]> {
  // Priority 1: Use curated list if provided
  if (config.knownFreeModels && config.knownFreeModels.length > 0) {
    return config.knownFreeModels.map((m) => ({
      providerId: config.providerId,
      modelId: m.modelId,
      displayName: m.displayName,
      contextLength: m.contextLength,
      isFree: true,
      pricing: { prompt: 0, completion: 0 },
      modality: 'text',
      discoveredAt: Date.now(),
    }));
  }

  // Priority 2: Try API discovery as fallback
  try {
    const url = `${config.baseUrl}/models`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return [];

    const json = await res.json();
    return (json.data ?? []).map((m: { id: string }) => ({
      providerId: config.providerId,
      modelId: m.id,
      displayName: m.id,
      contextLength: 0, // OpenAI /models doesn't include context length
      isFree: true,
      pricing: { prompt: 0, completion: 0 },
      modality: 'text',
      discoveredAt: Date.now(),
    }));
  } catch {
    return [];
  }
}

// ======================== Pre-configured provider definitions ========================

/** Groq — ultra-fast LPU inference */
export const GROQ_CONFIG: OpenAICompatibleConfig = {
  providerId: 'groq',
  apiKey: '', // filled by user
  baseUrl: 'https://api.groq.com/openai/v1',
  knownFreeModels: [
    { modelId: 'llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B', contextLength: 131_072 },
    { modelId: 'llama-3.1-8b-instant', displayName: 'Llama 3.1 8B', contextLength: 131_072 },
    { modelId: 'qwen-3-32b', displayName: 'Qwen 3 32B', contextLength: 131_072 },
    { modelId: 'llama-scout-24b', displayName: 'Llama 4 Scout', contextLength: 131_072 },
  ],
};

/** Cerebras — wafer-scale engine */
export const CEREBRAS_CONFIG: OpenAICompatibleConfig = {
  providerId: 'cerebras',
  apiKey: '',
  baseUrl: 'https://api.cerebras.ai/v1',
  knownFreeModels: [
    { modelId: 'llama3.1-8b', displayName: 'Llama 3.1 8B', contextLength: 8_192 },
    { modelId: 'gpt-oss-120b', displayName: 'GPT-OSS 120B', contextLength: 131_072 },
    { modelId: 'qwen-3-235b-a22b-instruct-2507', displayName: 'Qwen 3 235B', contextLength: 32_768 },
    { modelId: 'zai-glm-4.7', displayName: 'Z.ai GLM 4.7', contextLength: 32_768 },
  ],
};

/** Mistral AI */
export const MISTRAL_CONFIG: OpenAICompatibleConfig = {
  providerId: 'mistral',
  apiKey: '',
  baseUrl: 'https://api.mistral.ai/v1',
  knownFreeModels: [
    { modelId: 'mistral-large-latest', displayName: 'Mistral Large', contextLength: 131_072 },
    { modelId: 'mistral-small-latest', displayName: 'Mistral Small', contextLength: 131_072 },
    { modelId: 'codestral-latest', displayName: 'Codestral', contextLength: 256_000 },
    { modelId: 'pixtral-12b-2409', displayName: 'Pixtral 12B', contextLength: 131_072 },
  ],
};

/** NVIDIA NIM */
export const NVIDIA_CONFIG: OpenAICompatibleConfig = {
  providerId: 'nvidia',
  apiKey: '',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  knownFreeModels: [
    { modelId: 'deepseek-ai/deepseek-r1', displayName: 'DeepSeek R1', contextLength: 131_072 },
    { modelId: 'meta/llama-3.3-70b-instruct', displayName: 'Llama 3.3 70B', contextLength: 131_072 },
    { modelId: 'moonshotai/kimi-k2.5-instruct', displayName: 'Kimi K2.5', contextLength: 131_072 },
  ],
};

/** Cloudflare Workers AI */
export const CLOUDFLARE_CONFIG: OpenAICompatibleConfig = {
  providerId: 'cloudflare',
  apiKey: '',
  baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai',
  knownFreeModels: [
    { modelId: '@cf/meta/llama-3.2-3b-instruct', displayName: 'Llama 3.2 3B', contextLength: 4_096 },
    { modelId: '@cf/mistral/mistral-7b-instruct-v0.1', displayName: 'Mistral 7B', contextLength: 4_096 },
  ],
};

/** Hugging Face Inference API */
export const HUGGINGFACE_CONFIG: OpenAICompatibleConfig = {
  providerId: 'huggingface',
  apiKey: '',
  baseUrl: 'https://api-inference.huggingface.co/v1',
  knownFreeModels: [
    { modelId: 'meta-llama/Llama-3.2-3B-Instruct', displayName: 'Llama 3.2 3B', contextLength: 8_192 },
    { modelId: 'meta-llama/Llama-3.2-1B-Instruct', displayName: 'Llama 3.2 1B', contextLength: 8_192 },
    { modelId: 'microsoft/Phi-3.5-mini-instruct', displayName: 'Phi 3.5 Mini', contextLength: 128_000 },
    { modelId: 'HuggingFaceH4/zephyr-7b-beta', displayName: 'Zephyr 7B', contextLength: 8_192 },
    { modelId: 'google/gemma-2-2b-it', displayName: 'Gemma 2 2B', contextLength: 8_192 },
  ],
};

/** GitHub Models */
export const GITHUB_CONFIG: OpenAICompatibleConfig = {
  providerId: 'github',
  apiKey: '',
  baseUrl: 'https://models.inference.ai.azure.com',
  knownFreeModels: [
    { modelId: 'gpt-4o', displayName: 'GPT-4o', contextLength: 128_000 },
    { modelId: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini', contextLength: 128_000 },
    { modelId: 'o3-mini', displayName: 'o3-mini', contextLength: 200_000 },
    { modelId: 'deepseek-r1', displayName: 'DeepSeek R1', contextLength: 128_000 },
    { modelId: 'llama-3.3-70b-instruct', displayName: 'Llama 3.3 70B', contextLength: 128_000 },
  ],
};
