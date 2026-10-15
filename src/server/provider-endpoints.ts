// ---------------------------------------------------------------------------
// Provider endpoint resolution
//
// One place that decides which base URL a provider talks to, so the agent
// adapter and the conversation summariser cannot drift apart. Env overrides are
// normalised to include the version path, which means both of these work:
//
//   DEEPSEEK_BASE_URL=https://gateway.example.com
//   DEEPSEEK_BASE_URL=https://gateway.example.com/v1
//
// and both resolve to https://gateway.example.com/v1.
// ---------------------------------------------------------------------------

import type { ModelProvider } from "@/shared/types";
import { requireModelProviderProfile } from "@/server/model-provider-service";

/** Built-in endpoints, used when neither the agent nor the environment overrides them. */
export const PROVIDER_BASE_URLS: Partial<Record<ModelProvider, string>> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  "volcano-ark": "https://ark.cn-beijing.volces.com/api/v3",
  anthropic: "https://api.anthropic.com/v1"
};

/** Environment variable that overrides each provider's endpoint. */
const PROVIDER_BASE_URL_ENV: Partial<Record<ModelProvider, string>> = {
  openai: "OPENAI_BASE_URL",
  deepseek: "DEEPSEEK_BASE_URL",
  "volcano-ark": "ARK_BASE_URL",
  anthropic: "ANTHROPIC_BASE_URL"
};

/**
 * Normalise a *configured default* endpoint so it ends in a version segment.
 *
 * A bare host gets `/v1` appended, while an endpoint that already carries a
 * version (`/v1`, `/v3`, `/v1beta`, …) is left alone — appending blindly
 * produced `/v1/v1` and made the setting look broken.
 *
 * Only `<PROVIDER>_BASE_URL` and the built-in defaults go through this. An
 * explicit per-agent `apiBaseUrl` is used verbatim: it was passed straight to
 * the SDK before, and rewriting it would silently change what an existing
 * configuration means.
 */
export function normalizeApiBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /\/v\d+[a-z0-9]*$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * Resolve the base URL for a provider.
 *
 * Precedence: explicit override (typically the agent's `apiBaseUrl`) →
 * `<PROVIDER>_BASE_URL` → the built-in endpoint. Returns `undefined` when the
 * provider has no known endpoint at all.
 *
 * The override is returned as given (bar surrounding whitespace) so an existing
 * agent configuration keeps resolving to exactly the same URL as before; only
 * the environment and built-in defaults are normalised.
 */
export function resolveProviderBaseUrl(
  provider: string,
  override?: string | null
): string | undefined {
  // Validate references even with an agent override: missing profiles must fail closed.
  const profile = provider.startsWith("profile:") ? requireModelProviderProfile(provider) : null;
  const explicit = override?.trim();
  if (explicit) return explicit;
  if (profile) return profile.baseUrl;

  const envKey = PROVIDER_BASE_URL_ENV[provider as ModelProvider];
  const envValue = envKey ? process.env[envKey] : undefined;
  if (envValue?.trim()) return normalizeApiBaseUrl(envValue);

  return PROVIDER_BASE_URLS[provider as ModelProvider];
}
