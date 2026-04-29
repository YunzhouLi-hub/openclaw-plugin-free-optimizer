import type { PlatformModel } from '../lib/types.js';
import { discoverFreeModels as discoverOpenRouter } from './openrouter.js';
import { discoverFreeModels as discoverGoogle } from './google.js';
import {
  discoverFreeModels as discoverOpenAICompatible,
  GROQ_CONFIG,
  CEREBRAS_CONFIG,
  MISTRAL_CONFIG,
  NVIDIA_CONFIG,
  CLOUDFLARE_CONFIG,
  GITHUB_CONFIG,
  HUGGINGFACE_CONFIG,
} from './openai-compatible.js';

/**
 * Provider registry: central hub for discovering models across all platforms.
 */

export interface ProviderCredentials {
  openrouter?: { apiKey: string };
  google?: { apiKey: string };
  groq?: { apiKey: string };
  cerebras?: { apiKey: string };
  mistral?: { apiKey: string };
  nvidia?: { apiKey: string };
  cloudflare?: { apiKey: string; accountId: string };
  github?: { apiKey: string };
  huggingface?: { apiKey: string };
}

export interface ProviderRegistry {
  /** All platform adapters keyed by providerId */
  adapters: Map<string, PlatformAdapter>;
}

export interface PlatformAdapter {
  providerId: string;
  displayName: string;
  /** Discover free models from this platform */
  discover: (creds: Record<string, string>) => Promise<PlatformModel[]>;
  /** Get chat endpoint for a specific model */
  getChatUrl: (creds: Record<string, string>, modelId: string) => string;
  /** Get auth header for API requests */
  getAuthHeader: (creds: Record<string, string>) => Record<string, string>;
}

/**
 * Build the provider registry from user credentials.
 * Only includes providers whose API key is configured.
 */
export function buildRegistry(creds: ProviderCredentials): ProviderRegistry {
  const adapters = new Map<string, PlatformAdapter>();

  // --- OpenRouter ---
  if (creds.openrouter?.apiKey) {
    adapters.set('openrouter', {
      providerId: 'openrouter',
      displayName: 'OpenRouter',
      discover: async () =>
        discoverOpenRouter({ apiKey: creds.openrouter!.apiKey }),
      getChatUrl: () => 'https://openrouter.ai/api/v1/chat/completions',
      getAuthHeader: () => ({
        Authorization: `Bearer ${creds.openrouter!.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/openclaw-free-optimizer',
        'X-Title': 'OpenClaw Free Optimizer',
      }),
    });
  }

  // --- Google AI Studio ---
  if (creds.google?.apiKey) {
    adapters.set('google', {
      providerId: 'google',
      displayName: 'Google AI Studio',
      discover: async () =>
        discoverGoogle({ apiKey: creds.google!.apiKey }),
      getChatUrl: (c, modelId) =>
        `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions?key=${creds.google!.apiKey}`,
      getAuthHeader: () => ({
        'Content-Type': 'application/json',
      }),
    });
  }

  // --- Groq ---
  if (creds.groq?.apiKey) {
    adapters.set('groq', {
      providerId: 'groq',
      displayName: 'Groq',
      discover: async () =>
        discoverOpenAICompatible({
          ...GROQ_CONFIG,
          apiKey: creds.groq!.apiKey,
        }),
      getChatUrl: () => 'https://api.groq.com/openai/v1/chat/completions',
      getAuthHeader: () => ({
        Authorization: `Bearer ${creds.groq!.apiKey}`,
        'Content-Type': 'application/json',
      }),
    });
  }

  // --- Cerebras ---
  if (creds.cerebras?.apiKey) {
    adapters.set('cerebras', {
      providerId: 'cerebras',
      displayName: 'Cerebras',
      discover: async () =>
        discoverOpenAICompatible({
          ...CEREBRAS_CONFIG,
          apiKey: creds.cerebras!.apiKey,
        }),
      getChatUrl: () => 'https://api.cerebras.ai/v1/chat/completions',
      getAuthHeader: () => ({
        Authorization: `Bearer ${creds.cerebras!.apiKey}`,
        'Content-Type': 'application/json',
      }),
    });
  }

  // --- Mistral ---
  if (creds.mistral?.apiKey) {
    adapters.set('mistral', {
      providerId: 'mistral',
      displayName: 'Mistral AI',
      discover: async () =>
        discoverOpenAICompatible({
          ...MISTRAL_CONFIG,
          apiKey: creds.mistral!.apiKey,
        }),
      getChatUrl: () => 'https://api.mistral.ai/v1/chat/completions',
      getAuthHeader: () => ({
        Authorization: `Bearer ${creds.mistral!.apiKey}`,
        'Content-Type': 'application/json',
      }),
    });
  }

  // --- NVIDIA ---
  if (creds.nvidia?.apiKey) {
    adapters.set('nvidia', {
      providerId: 'nvidia',
      displayName: 'NVIDIA NIM',
      discover: async () =>
        discoverOpenAICompatible({
          ...NVIDIA_CONFIG,
          apiKey: creds.nvidia!.apiKey,
        }),
      getChatUrl: () => 'https://integrate.api.nvidia.com/v1/chat/completions',
      getAuthHeader: () => ({
        Authorization: `Bearer ${creds.nvidia!.apiKey}`,
        'Content-Type': 'application/json',
      }),
    });
  }

  // --- Cloudflare ---
  if (creds.cloudflare?.apiKey) {
    adapters.set('cloudflare', {
      providerId: 'cloudflare',
      displayName: 'Cloudflare Workers AI',
      discover: async () =>
        discoverOpenAICompatible({
          ...CLOUDFLARE_CONFIG,
          apiKey: creds.cloudflare!.apiKey,
          baseUrl: CLOUDFLARE_CONFIG.baseUrl.replace(
            '{ACCOUNT_ID}',
            creds.cloudflare!.accountId ?? ''
          ),
        }),
      getChatUrl: (c, modelId) => {
        const accountId = creds.cloudflare!.accountId ?? '';
        return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`;
      },
      getAuthHeader: () => ({
        Authorization: `Bearer ${creds.cloudflare!.apiKey}`,
        'Content-Type': 'application/json',
      }),
    });
  }

  // --- Hugging Face ---
  if (creds.huggingface?.apiKey) {
    adapters.set('huggingface', {
      providerId: 'huggingface',
      displayName: 'Hugging Face',
      discover: async () =>
        discoverOpenAICompatible({
          ...HUGGINGFACE_CONFIG,
          apiKey: creds.huggingface!.apiKey,
        }),
      getChatUrl: () => 'https://api-inference.huggingface.co/v1/chat/completions',
      getAuthHeader: () => ({
        Authorization: `Bearer ${creds.huggingface!.apiKey}`,
        'Content-Type': 'application/json',
      }),
    });
  }

  // --- GitHub Models ---
  if (creds.github?.apiKey) {
    adapters.set('github', {
      providerId: 'github',
      displayName: 'GitHub Models',
      discover: async () =>
        discoverOpenAICompatible({
          ...GITHUB_CONFIG,
          apiKey: creds.github!.apiKey,
        }),
      getChatUrl: () => 'https://models.inference.ai.azure.com/chat/completions',
      getAuthHeader: () => ({
        Authorization: `Bearer ${creds.github!.apiKey}`,
        'Content-Type': 'application/json',
      }),
    });
  }

  return { adapters };
}

/**
 * Discover free models from all configured providers in parallel.
 */
export async function discoverAllProviders(
  registry: ProviderRegistry
): Promise<PlatformModel[]> {
  const results: PlatformModel[][] = [];

  const promises = Array.from(registry.adapters.values()).map(async (adapter) => {
    try {
      const models = await adapter.discover({});
      results.push(models);
    } catch (err) {
      console.error(`[registry] Failed to discover ${adapter.providerId}:`, (err as Error).message);
    }
  });

  await Promise.all(promises);

  return results.flat();
}

/**
 * Get the best available chat endpoint for a given model.
 * Returns the adapter's chat URL + auth headers, or null if model not found.
 */
export function getChatEndpoint(
  registry: ProviderRegistry,
  model: PlatformModel
): { url: string; headers: Record<string, string> } | null {
  const adapter = registry.adapters.get(model.providerId);
  if (!adapter) return null;

  return {
    url: adapter.getChatUrl({}, model.modelId),
    headers: adapter.getAuthHeader({}),
  };
}
