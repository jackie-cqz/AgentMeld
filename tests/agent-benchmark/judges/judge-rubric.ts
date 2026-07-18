export const JUDGE_PROMPT_VERSION = "agentmeld-judge-v1";
export const DEFAULT_RUBRIC_VERSION = "collaboration-rubric-v1";

export interface JudgeRubricDimension {
  id: string;
  weight: number;
  description: string;
}

export const DEFAULT_JUDGE_RUBRIC: JudgeRubricDimension[] = [
  { id: "requirement_coverage", weight: 0.20, description: "The delivered artifacts cover the user's explicit requirements." },
  { id: "role_specialization", weight: 0.10, description: "Each role contributes work appropriate to its specialty." },
  { id: "handoff_quality", weight: 0.20, description: "Downstream work concretely uses relevant upstream decisions and artifacts." },
  { id: "cross_artifact_consistency", weight: 0.15, description: "PRD, design, implementation, and review do not contradict one another." },
  { id: "implementation_fidelity", weight: 0.15, description: "The implementation faithfully realizes the agreed requirements and design." },
  { id: "review_quality", weight: 0.10, description: "Review identifies concrete issues and evaluates acceptance criteria with evidence." },
  { id: "final_summary_accuracy", weight: 0.10, description: "The final summary accurately reflects verified work without unsupported claims." },
];

export const SCORE_ANCHORS = {
  0: "Completely missing, contradictory, or unusable.",
  1: "Major gaps prevent downstream use.",
  2: "Partially satisfied but requires substantial rework.",
  3: "Usable and mostly complete with minor issues.",
  4: "Complete, specific, consistent, and supported by evidence.",
} as const;

export function selectRubricDimensions(requested?: string[]): JudgeRubricDimension[] {
  if (!requested?.length) return DEFAULT_JUDGE_RUBRIC;
  const requestedSet = new Set(requested);
  const selected = DEFAULT_JUDGE_RUBRIC.filter((dimension) => requestedSet.has(dimension.id));
  const unknown = requested.filter((dimension) => !DEFAULT_JUDGE_RUBRIC.some((candidate) => candidate.id === dimension));
  if (unknown.length > 0) throw new Error(`Unknown judge rubric dimensions: ${unknown.join(", ")}`);
  const total = selected.reduce((sum, item) => sum + item.weight, 0);
  return selected.map((item) => ({ ...item, weight: item.weight / total }));
}
