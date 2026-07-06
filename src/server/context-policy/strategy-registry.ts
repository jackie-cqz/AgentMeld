// ---------------------------------------------------------------------------
// P7: Context Strategy Registry — A/B comparison of context strategies
// ---------------------------------------------------------------------------

export type ContextStrategyName =
  | "recent_messages_only"
  | "summary_plus_recent"
  | "evidence_aware_context"
  | "evidence_aware_context_with_role_contracts";

export interface ContextStrategyConfig {
  name: ContextStrategyName;
  label: string;
  description: string;
  /** Whether to use evidence-aware context compilation */
  useEvidenceAware: boolean;
  /** Whether to include role contracts in plan generation */
  useRoleContracts: boolean;
  /** Whether to include active facts */
  useActiveFacts: boolean;
  /** Whether to use FTS retrieval for optional context */
  useRetrieval: boolean;
  /** Whether to include conversation summary */
  useSummary: boolean;
  /** Max recent messages to include */
  maxRecentMessages: number;
}

/** All registered strategies for A/B comparison */
export const STRATEGIES: Record<ContextStrategyName, ContextStrategyConfig> = {
  recent_messages_only: {
    name: "recent_messages_only",
    label: "仅最近消息",
    description: "Baseline: only the most recent N messages, no evidence awareness or facts.",
    useEvidenceAware: false,
    useRoleContracts: false,
    useActiveFacts: false,
    useRetrieval: false,
    useSummary: false,
    maxRecentMessages: 20,
  },
  summary_plus_recent: {
    name: "summary_plus_recent",
    label: "摘要 + 最近消息",
    description: "Conversation summary plus recent messages, no evidence awareness.",
    useEvidenceAware: false,
    useRoleContracts: false,
    useActiveFacts: false,
    useRetrieval: false,
    useSummary: true,
    maxRecentMessages: 10,
  },
  evidence_aware_context: {
    name: "evidence_aware_context",
    label: "证据驱动上下文",
    description: "Full evidence-aware pipeline: facts, DAG inputs, verification, manifest, budget packing.",
    useEvidenceAware: true,
    useRoleContracts: false,
    useActiveFacts: true,
    useRetrieval: true,
    useSummary: false,
    maxRecentMessages: 5,
  },
  evidence_aware_context_with_role_contracts: {
    name: "evidence_aware_context_with_role_contracts",
    label: "证据驱动 + 角色协议",
    description: "Evidence-aware context plus standardized role contracts for consistent output keys.",
    useEvidenceAware: true,
    useRoleContracts: true,
    useActiveFacts: true,
    useRetrieval: true,
    useSummary: false,
    maxRecentMessages: 5,
  },
};

/** Get the active strategy (default: evidence-aware with role contracts) */
export function getActiveStrategy(): ContextStrategyConfig {
  const envStrategy = process.env.AGENTMELD_CONTEXT_STRATEGY as ContextStrategyName | undefined;
  if (envStrategy && STRATEGIES[envStrategy]) return STRATEGIES[envStrategy];
  return STRATEGIES.evidence_aware_context_with_role_contracts;
}

/** Compare metrics between two strategies */
export interface StrategyComparison {
  baseline: ContextStrategyName;
  candidate: ContextStrategyName;
  metrics: Array<{
    label: string;
    baselineValue: number;
    candidateValue: number;
    /** Positive means candidate is better, negative means worse */
    delta: number;
    deltaPercent: number;
  }>;
}

/** Compare two strategy runs (stub — actual comparison requires paired runs) */
export function compareStrategies(
  baseline: ContextStrategyName,
  candidate: ContextStrategyName,
  baselineMetrics: { taskCompletionRate: number; upstreamArtifactReadRate: number; toolFailureRate: number; deploymentSuccessRate: number; retryRate: number },
  candidateMetrics: { taskCompletionRate: number; upstreamArtifactReadRate: number; toolFailureRate: number; deploymentSuccessRate: number; retryRate: number },
): StrategyComparison {
  const pairs: Array<[string, number, number]> = [
    ["任务完成率", baselineMetrics.taskCompletionRate, candidateMetrics.taskCompletionRate],
    ["上游产物读取率", baselineMetrics.upstreamArtifactReadRate, candidateMetrics.upstreamArtifactReadRate],
    ["工具失败率", baselineMetrics.toolFailureRate, candidateMetrics.toolFailureRate],
    ["部署成功率", baselineMetrics.deploymentSuccessRate, candidateMetrics.deploymentSuccessRate],
    ["重试率", baselineMetrics.retryRate, candidateMetrics.retryRate],
  ];

  return {
    baseline,
    candidate,
    metrics: pairs.map(([label, b, c]) => ({
      label,
      baselineValue: b,
      candidateValue: c,
      delta: Math.round((c - b) * 1000) / 1000,
      deltaPercent: b !== 0 ? Math.round(((c - b) / b) * 1000) / 10 : (c !== 0 ? 100 : 0),
    })),
  };
}
