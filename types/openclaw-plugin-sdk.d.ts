// Ambient type declarations for OpenClaw Plugin SDK types not re-exported
// from the public barrel (openclaw/plugin-sdk).
// Keep in sync with openclaw/dist/plugin-sdk/src/plugins/types.d.ts

/**
 * Model definition for provider catalog model entries.
 */
export type ProviderCatalogModelDef = {
  id: string;
  name: string;
  api?: string;
  baseUrl?: string;
  reasoning: boolean;
  input: Array<'text' | 'image' | 'video' | 'audio'>;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
};

/**
 * Single-provider catalog result shape.
 */
export type SingleProviderCatalogResult = {
  provider: {
    baseUrl?: string;
    apiKey?: string;
    api?: string;
    models: ProviderCatalogModelDef[];
  };
};

/**
 * Multi-provider catalog result shape.
 */
export type MultiProviderCatalogResult = {
  providers: Record<string, {
    baseUrl?: string;
    apiKey?: string;
    api?: string;
    models: ProviderCatalogModelDef[];
  }>;
};

/**
 * Return type for catalog run().
 */
export type ProviderCatalogResult = SingleProviderCatalogResult | MultiProviderCatalogResult | null | undefined;

/**
 * Catalog hook: order + run().
 */
export type ProviderPluginCatalog = {
  order: string;
  run: (ctx: Record<string, unknown>) => Promise<ProviderCatalogResult>;
};

/**
 * Context for resolveDynamicModel hook.
 */
export type ProviderResolveDynamicModelContext = {
  config?: Record<string, unknown>;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  modelRegistry: Record<string, unknown>;
  providerConfig?: {
    baseUrl?: string;
    api?: string;
    models?: unknown;
    headers?: unknown;
  };
};

/**
 * Context for prepareDynamicModel hook.
 */
export type ProviderPrepareDynamicModelContext = {
  provider: string;
  modelId: string;
};

/**
 * Resolved runtime model returned by resolveDynamicModel.
 */
export type ProviderRuntimeModel = {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl?: string;
  apiKey?: string;
  reasoning: boolean;
  input: Array<'text' | 'image' | 'video' | 'audio'>;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
};

/**
 * Provider plugin definition (subset of the full type).
 */
// Minimal auth method shape — the actual type is complex but just needs to be compatible
export type ProviderPlugin = {
  id: string;
  pluginId?: string;
  label: string;
  docsPath?: string;
  aliases?: string[];
  envVars?: string[];
  // Use `any` here since the real ProviderAuthMethod type is complex and
  // not imported — the actual value comes from createProviderApiKeyAuthMethod
  // which returns a compatible type at runtime.
  auth: any[];
  catalog?: ProviderPluginCatalog;
  staticCatalog?: ProviderPluginCatalog;
  resolveDynamicModel?: (ctx: ProviderResolveDynamicModelContext) => ProviderRuntimeModel | null | undefined;
  prepareDynamicModel?: (ctx: ProviderPrepareDynamicModelContext) => Promise<void>;
  [key: string]: unknown;
};

/**
 * Plugin service (no label field).
 */
export type OpenClawPluginService = {
  id: string;
  start: (ctx: Record<string, unknown>) => void | Promise<void>;
  stop?: (ctx: Record<string, unknown>) => void | Promise<void>;
};

/**
 * Command handler return type.
 */
export type PluginCommandResult = { text: string };
