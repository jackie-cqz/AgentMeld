// ---------------------------------------------------------------------------
// P4: Verification Engine — validate task criteria against persisted evidence
// ---------------------------------------------------------------------------

import type { ParsedTask } from "@/server/tools/conductor-tools";
import type { CriterionVerdict } from "@/shared/evidence-types";
import type { AcceptanceCriterionSpec } from "@/shared/types";
import { listEvidenceForAttempt } from "@/server/repositories/evidence-repository";
import { resolveValidator, validateCriterion } from "@/server/verification/validator-registry";

export interface TaskVerificationResult {
  status: "verified" | "rejected" | "needs_review";
  verdicts: CriterionVerdict[];
  verifiedOutputBindings: Array<{ outputKey: string; artifactId: string; evidenceIds: string[] }>;
}

/**
 * Verify a task attempt against its acceptance criteria.
 * Queries the evidence ledger for the attempt and validates each criterion.
 */
export async function verifyTaskAttempt(
  task: ParsedTask,
  attemptId: string,
  taskReport: { artifacts?: Record<string, string>; summary?: string } | undefined
): Promise<TaskVerificationResult> {
  const criteria = normalizeCriteria(task.acceptanceCriteria);
  const evidence = await safeLoadEvidence(attemptId);
  const now = Date.now();
  const verdicts: CriterionVerdict[] = [];
  const verifiedOutputBindings: TaskVerificationResult["verifiedOutputBindings"] = [];
  let hasFailure = false;
  let hasReviewNeeded = false;

  for (const criterion of criteria) {
    const validator = resolveValidator(criterion.validator);
    const result = validateCriterion(criterion, validator, evidence, taskReport);

    const verdict: CriterionVerdict = {
      id: `vd_${criterion.id}_${now}`,
      criterionId: criterion.id,
      status: result.passed ? "passed" : (criterion.required ? "failed" : "missing"),
      validatorType: criterion.validator.type ?? "reviewer_verdict",
      evidenceIds: result.evidenceIds ?? [],
      reason: result.reason,
      checkedAt: now,
    };

    verdicts.push(verdict);

    if (verdict.status === "failed" && criterion.required) {
      hasFailure = true;
    }
    if (verdict.status === "needs_review") {
      hasReviewNeeded = true;
    }
  }

  // Build verified output bindings from artifact evidence
  if (taskReport?.artifacts) {
    for (const [outputKey, artifactId] of Object.entries(taskReport.artifacts)) {
      const hasEvidence = evidence.some(
        (e) => e.type === "artifact_created" && (e.subjectId === outputKey || e.payloadJson?.includes(outputKey))
      );
      if (hasEvidence) {
        verifiedOutputBindings.push({
          outputKey,
          artifactId,
          evidenceIds: evidence.filter(e => e.type === "artifact_created").map(e => e.id),
        });
      }
    }
  }

  const status: TaskVerificationResult["status"] = hasFailure ? "rejected" : hasReviewNeeded ? "needs_review" : "verified";

  return { status, verdicts, verifiedOutputBindings };
}

function normalizeCriteria(raw: (string | AcceptanceCriterionSpec)[]): AcceptanceCriterionSpec[] {
  return raw.map((c, i) => {
    if (typeof c === "string") {
      // Default: reviewer_verdict for free-text criteria (§10.2)
      return { id: `criterion_${i}`, description: c, required: true, validator: { type: "reviewer_verdict" } };
    }
    return c;
  });
}

async function safeLoadEvidence(attemptId: string): Promise<Array<{ id: string; type: string; subjectId: string; payloadJson: string; status: string }>> {
  try {
    return listEvidenceForAttempt(attemptId) as unknown as Array<{ id: string; type: string; subjectId: string; payloadJson: string; status: string }>;
  } catch {
    return [];
  }
}
