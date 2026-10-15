import type { AppSettings } from "@/shared/types";

export type ProviderValues = Pick<AppSettings, "deepseekApiKey" | "openaiApiKey" | "arkApiKey" | "anthropicApiKey" | "anthropicBaseUrl">;
export type ProviderKey = Exclude<keyof ProviderValues, "anthropicBaseUrl">;
export type ProviderId = "deepseek" | "openai" | "volcano-ark" | "anthropic";
export type CredentialSource = "app_settings" | "environment" | "missing";
export type ProviderSources = Partial<Record<ProviderId, CredentialSource>>;
export interface ProviderSnapshot { settings: ProviderValues; keySources: ProviderSources }
export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  key: ProviderKey;
  mark: string;
  endpoint: string;
  protocol: string;
  testModel?: string;
}

export const MODEL_PROVIDERS: readonly ProviderDefinition[] = [
  { id: "deepseek", name: "DeepSeek", key: "deepseekApiKey", mark: "D", endpoint: "https://api.deepseek.com/v1", protocol: "Chat Completions", testModel: "deepseek-chat" },
  { id: "openai", name: "OpenAI", key: "openaiApiKey", mark: "O", endpoint: "https://api.openai.com/v1", protocol: "OpenAI API", testModel: "gpt-4o-mini" },
  { id: "volcano-ark", name: "火山方舟", key: "arkApiKey", mark: "V", endpoint: "https://ark.cn-beijing.volces.com/api/v3", protocol: "Chat Completions", testModel: "doubao-seed-2-0-lite-260428" },
  { id: "anthropic", name: "Anthropic", key: "anthropicApiKey", mark: "A", endpoint: "https://api.anthropic.com", protocol: "Anthropic API" }
];

export function providerSource(provider: ProviderDefinition, settings: ProviderValues, sources: ProviderSources): CredentialSource {
  return settings[provider.key] ? "app_settings" : sources[provider.id] ?? "missing";
}

export function providerIsListed(provider: ProviderDefinition, settings: ProviderValues, sources: ProviderSources) {
  return providerSource(provider, settings, sources) !== "missing" || (provider.id === "anthropic" && Boolean(settings.anthropicBaseUrl));
}

export function providerPatch(provider: ProviderDefinition, keyDraft: string, baseUrl: string, settings: ProviderValues): Partial<ProviderValues> {
  const patch: Partial<ProviderValues> = {};
  const key = keyDraft.trim();
  if (key) patch[provider.key] = key;
  if (provider.id === "anthropic" && (baseUrl.trim() || null) !== settings.anthropicBaseUrl) patch.anthropicBaseUrl = baseUrl.trim() || null;
  return patch;
}

// A provider save must not overwrite an unrelated publishing draft in Settings.
export function mergeProviderValues<T extends ProviderValues>(current: T, updated: ProviderValues): T {
  return { ...current, deepseekApiKey: updated.deepseekApiKey, openaiApiKey: updated.openaiApiKey,
    arkApiKey: updated.arkApiKey, anthropicApiKey: updated.anthropicApiKey, anthropicBaseUrl: updated.anthropicBaseUrl };
}
