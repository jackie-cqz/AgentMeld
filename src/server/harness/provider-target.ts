import { getDatabase } from "@/db/client";
import { getSettings, resolveApiKey } from "@/server/settings-service";
import { resolveProviderBaseUrl } from "@/server/provider-endpoints";
import type { Agent } from "@/shared/types";
import type { HarnessProviderTarget } from "./types";

/**
 * Resolve the provider/model target the platform hands a harness.
 *
 * This is platform policy (which provider, endpoint and credential an Agent
 * resolves to), not Pi configuration: it deliberately returns a neutral target
 * so a second harness never inherits Pi's snapshot object. The model-shaping
 * choices the Agent owns — thinking effort, image input and the configured
 * context window — travel with the target, so a driver never has to read them
 * back off a platform `Agent` row. The resolution order and revision string are
 * unchanged from `snapshotPiProvider`, which now derives from this function.
 */
export function resolveHarnessProvider(agent: Agent): HarnessProviderTarget {
  const provider = agent.modelProvider ?? "deepseek";
  const settings = getSettings();
  const revision = provider.startsWith("profile:")
    ? getDatabase().prepare("SELECT updated_at,preset_id FROM model_provider_profiles WHERE id=?").get(provider.slice(8)) as { updated_at: number; preset_id?: string } | undefined
    : getDatabase().prepare("SELECT updated_at FROM app_settings WHERE id='singleton'").get() as { updated_at: number; preset_id?: string } | undefined;
  return {
    providerId: provider,
    catalogProvider: revision?.preset_id ?? provider,
    modelId: agent.modelId,
    endpoint: resolveProviderBaseUrl(provider, agent.apiBaseUrl ?? (provider === "anthropic" ? settings.anthropicBaseUrl : null)) ?? null,
    credential: resolveApiKey(provider, agent.apiKey, settings),
    revision: `${provider}:${revision?.updated_at ?? 0}`,
    reasoningEffort: agent.reasoningEffort,
    vision: agent.supportsVision,
    contextWindow: agent.contextWindow,
  };
}
