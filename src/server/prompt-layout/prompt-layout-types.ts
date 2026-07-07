// ---------------------------------------------------------------------------
// P0: Prompt Layout types — stable prefix + dynamic suffix for cache efficiency
// ---------------------------------------------------------------------------

export interface PromptLayout {
  stablePrefix: string;
  dynamicSuffix: string;
  cacheKey: string;
  sections: PromptLayoutSection[];
}

export interface PromptLayoutSection {
  id: string;
  placement: "stable_prefix" | "dynamic_suffix";
  title: string;
  content: string;
  tokenEstimate: number;
  stable: boolean;
}

export interface PromptLayoutInput {
  /** Agent identity + system prompt */
  agentId: string;
  agentName: string;
  agentSystemPrompt: string;
  agentCapabilities: string[];
  /** Tool names available to this agent */
  toolNames: string[];
  /** Role contract version (for cache key) */
  roleContractVersion: string;
  /** Platform prompt version (for cache key) */
  platformPromptVersion: string;
  /** Stable sections contributed by the adapter/platform */
  stableSections: { id: string; title: string; content: string; tokenEstimate: number }[];
  /** Dynamic content — task, context, user message */
  userMessage: string;
  taskPrompt: string;
  taskContextXml: string;
  failureContextXml: string;
}
