import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeApiBaseUrl, resolveProviderBaseUrl } from "@/server/provider-endpoints";

const BASE_URL_ENV_KEYS = [
  "DEEPSEEK_BASE_URL",
  "OPENAI_BASE_URL",
  "ARK_BASE_URL",
  "ANTHROPIC_BASE_URL"
] as const;

const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  originalEnv.clear();
  for (const key of BASE_URL_ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of BASE_URL_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("normalizeApiBaseUrl", () => {
  it("appends /v1 to a bare host", () => {
    expect(normalizeApiBaseUrl("https://gateway.example.com")).toBe("https://gateway.example.com/v1");
    expect(normalizeApiBaseUrl("https://gateway.example.com/")).toBe("https://gateway.example.com/v1");
    expect(normalizeApiBaseUrl("  https://gateway.example.com  ")).toBe("https://gateway.example.com/v1");
  });

  it("keeps an existing version segment instead of doubling it", () => {
    // The old conversation-context helper stripped only /v1 and appended blindly,
    // so a /v3 endpoint became /v3/v1.
    expect(normalizeApiBaseUrl("https://gateway.example.com/v1")).toBe("https://gateway.example.com/v1");
    expect(normalizeApiBaseUrl("https://ark.example.com/api/v3")).toBe("https://ark.example.com/api/v3");
  });
});

describe("resolveProviderBaseUrl", () => {
  it("prefers the explicit override over the environment and the default", () => {
    process.env.DEEPSEEK_BASE_URL = "https://from-env.example.com";
    expect(resolveProviderBaseUrl("deepseek", "https://from-agent.example.com"))
      .toBe("https://from-agent.example.com/v1");
  });

  it("falls back to <PROVIDER>_BASE_URL when the agent has no base URL", () => {
    // Regression: an agent with apiBaseUrl = null used to ignore the environment
    // entirely, so a data-directory reset silently sent a gateway key to the
    // provider's public endpoint and surfaced as a confusing 401.
    process.env.DEEPSEEK_BASE_URL = "https://from-env.example.com";
    expect(resolveProviderBaseUrl("deepseek", null)).toBe("https://from-env.example.com/v1");
    expect(resolveProviderBaseUrl("deepseek")).toBe("https://from-env.example.com/v1");
  });

  it("uses the built-in endpoint when nothing overrides it", () => {
    expect(resolveProviderBaseUrl("deepseek", null)).toBe("https://api.deepseek.com/v1");
    expect(resolveProviderBaseUrl("openai", null)).toBe("https://api.openai.com/v1");
    expect(resolveProviderBaseUrl("volcano-ark", null)).toBe("https://ark.cn-beijing.volces.com/api/v3");
  });

  it("returns undefined for a provider with no known endpoint", () => {
    // openai-compatible must be configured per agent, so there is nothing to guess.
    expect(resolveProviderBaseUrl("openai-compatible", null)).toBeUndefined();
  });
});
