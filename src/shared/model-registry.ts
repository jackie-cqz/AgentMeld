import type { Agent, ModelProvider } from "@/shared/types";

export interface ModelLimits {
  contextWindow: number;
  outputReserve: number;
}

/**
 * The gateway's `deepseek-v4-flash` really serves a 1M-token window. This is
 * the default when an Agent has no configured `contextWindow` — not 64K (the
 * old registry number) and not 128K (the old Pi fallback). Both disagreed with
 * the provider, and Pi's compactor consequently fired about 9× too early.
 */
export const DEEPSEEK_DEFAULT_CONTEXT_WINDOW = 1_000_000;

const DEFAULT_LIMITS: Record<string, ModelLimits> = {
  anthropic: { contextWindow: 200_000, outputReserve: 24_000 },
  openai: { contextWindow: 128_000, outputReserve: 16_000 },
  deepseek: { contextWindow: DEEPSEEK_DEFAULT_CONTEXT_WINDOW, outputReserve: 8_000 },
  "volcano-ark": { contextWindow: 32_000, outputReserve: 4_000 },
  "openai-compatible": { contextWindow: 128_000, outputReserve: 16_000 }
};

export function getModelLimits(provider: ModelProvider | null): ModelLimits {
  if (provider && DEFAULT_LIMITS[provider]) {
    return DEFAULT_LIMITS[provider];
  }
  // Fallback for unknown providers
  return { contextWindow: 64_000, outputReserve: 4_000 };
}

/**
 * The single window resolution used by the app budget and Pi's models.json.
 *
 * A configured value always wins. Unset DeepSeek stays at the verified 1M
 * because the gateway, not the local catalog alias, defines the real limit;
 * other providers keep their catalog/registry default, so Agents that never
 * set the field behave exactly as they did.
 */
export function resolveContextWindow(
  agent: Pick<Agent, "modelProvider" | "contextWindow">,
  catalogContextWindow?: number | null
): number {
  if (typeof agent.contextWindow === "number" && agent.contextWindow > 0) return agent.contextWindow;
  if ((agent.modelProvider ?? "deepseek") === "deepseek") return DEEPSEEK_DEFAULT_CONTEXT_WINDOW;
  return catalogContextWindow ?? getModelLimits(agent.modelProvider).contextWindow;
}

/** 80% of the window is where app-level (cross-run) compaction starts. */
export const AUTO_COMPACTION_RATIO = 0.8;

export function autoCompactionThreshold(contextWindow: number): number {
  return Math.floor(contextWindow * AUTO_COMPACTION_RATIO);
}
