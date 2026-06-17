import type { ModelProvider } from "@/shared/types";

export interface ModelLimits {
  contextWindow: number;
  outputReserve: number;
}

const DEFAULT_LIMITS: Record<string, ModelLimits> = {
  anthropic: { contextWindow: 200_000, outputReserve: 24_000 },
  openai: { contextWindow: 128_000, outputReserve: 16_000 },
  deepseek: { contextWindow: 64_000, outputReserve: 8_000 },
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
