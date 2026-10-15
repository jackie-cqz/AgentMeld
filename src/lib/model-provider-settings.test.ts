import { describe, expect, it } from "vitest";
import { MODEL_PROVIDERS, mergeProviderValues, providerIsListed, providerPatch, providerSource, type ProviderValues } from "@/lib/model-provider-settings";

const empty: ProviderValues = { deepseekApiKey: null, openaiApiKey: null, arkApiKey: null, anthropicApiKey: null, anthropicBaseUrl: null };
const deepseek = MODEL_PROVIDERS.find(provider => provider.id === "deepseek")!;
const anthropic = MODEL_PROVIDERS.find(provider => provider.id === "anthropic")!;

describe("provider settings", () => {
  it("does not list unused providers", () => {
    expect(MODEL_PROVIDERS.filter(provider => providerIsListed(provider, empty, {}))).toEqual([]);
  });
  it("lists environment providers without a local credential", () => {
    expect(providerIsListed(deepseek, empty, { deepseek: "environment" })).toBe(true);
    expect(providerSource(deepseek, empty, { deepseek: "environment" })).toBe("environment");
  });
  it("prefers a saved local credential", () => {
    expect(providerSource(deepseek, { ...empty, deepseekApiKey: "*****1234" }, { deepseek: "environment" })).toBe("app_settings");
  });
  it("retains an incomplete Anthropic URL configuration in the list", () => {
    expect(providerIsListed(anthropic, { ...empty, anthropicBaseUrl: "https://example.com" }, {})).toBe(true);
  });
  it("never resubmits a masked key when the new key field is blank", () => {
    expect(providerPatch(deepseek, " ", "", { ...empty, deepseekApiKey: "*****1234" })).toEqual({});
  });
  it("writes only the selected provider with a trimmed credential", () => {
    expect(providerPatch(deepseek, "  test-new-key  ", "https://unused.example.com", empty)).toEqual({ deepseekApiKey: "test-new-key" });
  });
  it("updates Anthropic URL without clearing its stored key", () => {
    expect(providerPatch(anthropic, "", " https://example.com/api ", { ...empty, anthropicApiKey: "*****1234" })).toEqual({ anthropicBaseUrl: "https://example.com/api" });
  });
  it("can clear only the Anthropic URL", () => {
    expect(providerPatch(anthropic, "", "", { ...empty, anthropicBaseUrl: "https://example.com" })).toEqual({ anthropicBaseUrl: null });
  });
  it("does not overwrite unsaved publishing fields with an unrelated provider response", () => {
    const current = { ...empty, deploymentPublishEnabled: true, deploymentPublishDir: "draft-dir" };
    const response = { ...empty, deepseekApiKey: "*****1234", deploymentPublishEnabled: false, deploymentPublishDir: "saved-dir" };
    expect(mergeProviderValues(current, response)).toEqual({ ...current, deepseekApiKey: "*****1234" });
  });
});
