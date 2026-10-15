import { describe, expect, it } from "vitest";
import { agentProviderChoices, emptyAgentModel, selectAgentProvider } from "./agent-model-config";
import type { ModelProviderProfile } from "@/shared/types";
import type { ProviderSnapshot } from "./model-provider-settings";

const snapshot: ProviderSnapshot = { settings: { deepseekApiKey: null, openaiApiKey: null, arkApiKey: null, anthropicApiKey: null, anthropicBaseUrl: null }, keySources: {} };
const profile: ModelProviderProfile = { id: "mp_test", name: "GLM 国内", presetId: "glm-cn", protocol: "chat-completions", baseUrl: "https://fixture.invalid/api/paas/v4", defaultModel: "glm-default", models: ["glm-other", "glm-default", "glm-other"], credentialSource: "app_settings", agentCount: 0 };

describe("Agent model selection", () => {
  it("starts with an explicit empty choice instead of a hardcoded provider", () => {
    expect(emptyAgentModel()).toEqual({ provider: null, modelId: "", apiKey: "", apiBaseUrl: "" });
    expect(agentProviderChoices([], snapshot, [], emptyAgentModel())).toEqual([]);
  });
  it("uses saved models and default while preserving regional endpoint and separate profile identities", () => {
    const choices = agentProviderChoices([profile, { ...profile, id: "mp_coding", name: "GLM Coding", baseUrl: "https://fixture.invalid/api/coding/paas/v4" }], snapshot, [], emptyAgentModel());
    expect(choices.map(choice => choice.id)).toEqual(["profile:mp_test", "profile:mp_coding"]);
    expect(choices[0].models).toEqual(["glm-default", "glm-other"]);
    expect(choices[1].baseUrl).toContain("/api/coding/paas/v4");
    expect(selectAgentProvider(emptyAgentModel(), choices[0]).modelId).toBe("glm-default");
  });
  it("lists only configured compatible globals and includes existing model IDs without retrieving credentials", () => {
    const choices = agentProviderChoices([], { ...snapshot, keySources: { openai: "environment", anthropic: "environment" } }, [{ modelProvider: "openai", modelId: "custom-openai" }, { modelProvider: "deepseek", modelId: "private-model" }], emptyAgentModel());
    expect(choices.map(choice => choice.id)).toEqual(["openai"]);
    expect(choices[0].models).toEqual(["gpt-4o-mini", "custom-openai"]);
    expect(JSON.stringify(choices)).not.toContain("ApiKey");
  });
  it("retains missing/private provider and manual model when editing", () => {
    const current = { provider: "profile:deleted" as const, modelId: "private-model", apiKey: "private-key", apiBaseUrl: "https://private.invalid/v1" };
    const [choice] = agentProviderChoices([], snapshot, [], current);
    expect(choice.id).toBe(current.provider);
    expect(choice.unavailable).toBe(true);
    expect(choice.models).toEqual(["private-model"]);
    expect(selectAgentProvider(current, choice)).toBe(current);
    expect(JSON.stringify(choice)).not.toContain("private-key");
  });
  it("does not mutate manual model/overrides on same-provider selection, clears them only on a different provider", () => {
    const current = { provider: "profile:mp_test" as const, modelId: "manual", apiKey: "agent-key", apiBaseUrl: "https://override.invalid" };
    const [choice] = agentProviderChoices([profile], snapshot, [], current);
    expect(selectAgentProvider(current, choice)).toBe(current);
    expect(selectAgentProvider(current, { ...choice, id: "profile:other" })).toEqual({ provider: "profile:other", modelId: "glm-default", apiKey: "", apiBaseUrl: "" });
    expect(current.apiKey).toBe("agent-key");
  });
});
