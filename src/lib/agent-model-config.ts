import type { Agent, ModelProvider, ModelProviderProfile } from "@/shared/types";
import { profileProviderId } from "@/shared/provider-presets";
import { MODEL_PROVIDERS, providerSource, type CredentialSource, type ProviderSnapshot } from "@/lib/model-provider-settings";

export interface AgentModelValue {
  provider: ModelProvider | null;
  modelId: string;
  apiKey: string;
  apiBaseUrl: string;
  /** Form text: empty means "provider default". Converted to number on submit. */
  contextWindow: string;
  /** Empty means thinking stays off (today's behaviour). */
  reasoningEffort: "" | "low" | "medium" | "high";
}

export interface AgentProviderChoice {
  id: ModelProvider;
  name: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
  source: CredentialSource;
  legacy: boolean;
  unavailable?: boolean;
}

export const emptyAgentModel = (): AgentModelValue => ({ provider: null, modelId: "", apiKey: "", apiBaseUrl: "", contextWindow: "", reasoningEffort: "" });

export function agentProviderChoices(profiles: ModelProviderProfile[], snapshot: ProviderSnapshot,
  agents: Pick<Agent, "modelProvider" | "modelId">[], current: AgentModelValue): AgentProviderChoice[] {
  const choices: AgentProviderChoice[] = profiles.map(profile => ({
    id: profileProviderId(profile.id), name: profile.name, baseUrl: profile.baseUrl,
    models: [...new Set([profile.defaultModel, ...profile.models].filter(Boolean))],
    defaultModel: profile.defaultModel, source: profile.credentialSource, legacy: false
  }));
  for (const provider of MODEL_PROVIDERS) {
    if (!provider.testModel || providerSource(provider, snapshot.settings, snapshot.keySources) === "missing") continue;
    choices.push({ id: provider.id, name: provider.name, baseUrl: provider.endpoint,
      models: [...new Set([provider.testModel, ...agents.filter(agent => agent.modelProvider === provider.id).map(agent => agent.modelId).filter((id): id is string => Boolean(id))])],
      defaultModel: provider.testModel, source: providerSource(provider, snapshot.settings, snapshot.keySources), legacy: true });
  }
  // Keep editing old/private configurations without inventing a replacement provider.
  if (current.provider && !choices.some(choice => choice.id === current.provider)) {
    const builtin = MODEL_PROVIDERS.find(provider => provider.id === current.provider);
    choices.push({ id: current.provider, name: builtin?.name ?? (current.provider === "openai-compatible" ? "独立 OpenAI-Compatible" : "原供应商配置"),
      baseUrl: current.apiBaseUrl || builtin?.endpoint || "", models: current.modelId ? [current.modelId] : [],
      defaultModel: current.modelId, source: "missing", legacy: true, unavailable: true });
  }
  return choices;
}

export function selectAgentProvider(current: AgentModelValue, provider: AgentProviderChoice): AgentModelValue {
  if (current.provider === provider.id) return current;
  return { provider: provider.id, modelId: provider.defaultModel, apiKey: "", apiBaseUrl: "", contextWindow: "", reasoningEffort: "" };
}
