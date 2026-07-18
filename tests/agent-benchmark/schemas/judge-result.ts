import { z } from "zod";

import type { JudgeResult } from "../judges/judge-types";

export const judgeResultSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  rubricVersion: z.string().min(1),
  packetHash: z.string().regex(/^[a-f0-9]{64}$/),
  dimensions: z.array(z.object({
    dimension: z.string().min(1),
    score: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    reason: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)),
  }).strict()).min(1),
  weightedScore: z.number().min(0).max(100),
  verdict: z.enum(["passed", "failed", "needs_human_review"]),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
  tokenUsage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).strict().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
}).strict();

export function parseJudgeResult(value: unknown, allowedEvidenceRefs?: Set<string>): JudgeResult {
  const result = judgeResultSchema.parse(value) as JudgeResult;
  const dimensions = new Set<string>();
  for (const dimension of result.dimensions) {
    if (dimensions.has(dimension.dimension)) throw new Error(`Duplicate judge dimension: ${dimension.dimension}`);
    dimensions.add(dimension.dimension);
    if (allowedEvidenceRefs) {
      const invalid = dimension.evidenceRefs.filter((reference) => !allowedEvidenceRefs.has(reference));
      if (invalid.length > 0) throw new Error(`Judge result references unknown evidence: ${invalid.join(", ")}`);
    }
  }
  return result;
}
