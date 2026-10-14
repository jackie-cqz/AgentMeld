// ---------------------------------------------------------------------------
// P4: Verification Engine — validate task criteria against persisted evidence
// ---------------------------------------------------------------------------

import type { ParsedTask } from "@/server/tools/conductor-tools";
import type { CriterionVerdict } from "@/shared/evidence-types";
import type { AcceptanceCriterionSpec } from "@/shared/types";
import { extractArtifactIds } from "@/server/evidence/artifact-reference";
import { listEvidenceForAttempt } from "@/server/repositories/evidence-repository";
import { getArtifact } from "@/server/repositories";
import { resolveValidator, validateCriterion, type ValidationResult } from "@/server/verification/validator-registry";

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
    let result = validateCriterion(criterion, validator, evidence, taskReport);
    result = maybePassStaticWebAppBuildCriterion(task, criterion, evidence, result);

    // P4: reviewer_verdict that can't auto-resolve:
    // Required → needs_review (blocks task until reviewer resolves).
    // Optional → missing (non-blocking, informational only — no evidence, no auto-pass).
    let verdictStatus: CriterionVerdict["status"];
    if (result.passed) {
      verdictStatus = "passed";
    } else if (result.reason.includes("pending review") || criterion.validator.type === "reviewer_verdict") {
      verdictStatus = criterion.required ? "needs_review" : "missing";
    } else {
      verdictStatus = criterion.required ? "failed" : "missing";
    }

    const verdict: CriterionVerdict = {
      id: `vd_${criterion.id}_${now}`,
      criterionId: criterion.id,
      status: verdictStatus,
      validatorType: criterion.validator.type ?? "reviewer_verdict",
      evidenceIds: result.evidenceIds ?? [],
      reason: result.reason,
      checkedAt: now,
    };

    verdicts.push(verdict);

    if (verdict.status === "failed" && criterion.required) {
      hasFailure = true;
    }
    // P4: Only required criteria in needs_review can block the task
    if (verdict.status === "needs_review" && criterion.required) {
      hasReviewNeeded = true;
    }
  }

  const unsupportedArtifactClaims = findUnsupportedArtifactClaims(taskReport, evidence);
  if (unsupportedArtifactClaims.length > 0) {
    hasFailure = true;
    verdicts.push({
      id: `vd_report-artifact-claims-supported_${now}`,
      criterionId: "report-artifact-claims-supported",
      status: "failed",
      validatorType: "artifact_exists",
      evidenceIds: [],
      reason:
        `guessed_artifact_id: task report referenced artifact ids without attempt evidence: ` +
        unsupportedArtifactClaims.join(", "),
      checkedAt: now,
    });
  }

  // Build verified output bindings from artifact evidence, not agent self-report.
  // write_artifact records artifact_created evidence with outputKey + artifactId;
  // that evidence is the authority for downstream task inputs.
  const expectedOutputs = new Map((task.expectedOutputs ?? []).map((output) => [output.id, output]));
  const evidenceByOutput = new Map<string, { artifactId: string; evidenceIds: string[] }>();
  for (const item of evidence) {
    if (item.type !== "artifact_created" || item.status !== "valid") continue;

    const payload = parseArtifactPayload(item.payloadJson);
    const outputKey = payload.outputKey || item.subjectId;
    const artifactId = payload.artifactId;
    if (!outputKey || !artifactId || !expectedOutputs.has(outputKey)) continue;
    const expectedOutput = expectedOutputs.get(outputKey);
    const artifact = getArtifact(artifactId);
    if (!artifact || artifact.type !== expectedOutput?.type || !isCompleteArtifact(artifact.content)) {
      continue;
    }

    // Evidence is loaded oldest-first. A later complete write for the same outputKey
    // is the final version for this attempt and replaces the previous candidate.
    evidenceByOutput.set(outputKey, {
      artifactId,
      evidenceIds: [item.id],
    });
  }

  for (const [outputKey, binding] of evidenceByOutput) {
    verifiedOutputBindings.push({
      outputKey,
      artifactId: binding.artifactId,
      evidenceIds: binding.evidenceIds,
    });
  }

  const status: TaskVerificationResult["status"] = hasFailure ? "rejected" : hasReviewNeeded ? "needs_review" : "verified";

  return { status, verdicts, verifiedOutputBindings };
}

function normalizeCriteria(raw: (string | AcceptanceCriterionSpec)[]): AcceptanceCriterionSpec[] {
  return raw.map((c, i) => {
    if (typeof c === "string") {
      // P5: Try to parse JSON-serialized structured criteria from role contracts
      try {
        const parsed = JSON.parse(c) as Record<string, unknown>;
        if (parsed && typeof parsed.id === "string" && typeof parsed.description === "string" && parsed.validator && typeof parsed.validator === "object") {
          return {
            id: parsed.id as string,
            description: parsed.description as string,
            required: parsed.required === true,
            validator: parsed.validator as AcceptanceCriterionSpec["validator"],
          };
        }
      } catch { /* not JSON, treat as free-text */ }
      // P4: Free-text criteria default to optional reviewer_verdict — don't block tasks
      return { id: `criterion_${i}`, description: c, required: false, validator: { type: "reviewer_verdict" } };
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

function maybePassStaticWebAppBuildCriterion(
  task: ParsedTask,
  criterion: AcceptanceCriterionSpec,
  evidence: Array<{ id: string; type: string; subjectId: string; payloadJson: string; status: string }>,
  result: ValidationResult
): ValidationResult {
  if (result.passed) return result;
  if (criterion.validator.type !== "command_exit") return result;
  if (normalizeCommand(criterion.validator.command) !== "pnpm build") return result;
  if (!result.reason.includes("was not executed")) return result;
  if (!task.expectedOutputs?.some((output) => output.type === "web_app")) return result;

  const hasPackageJson = evidence.some((item) =>
    item.status === "valid" &&
    item.type === "file_written" &&
    normalizePath(item.subjectId) === "package.json"
  );
  if (hasPackageJson) return result;

  const webAppArtifact = evidence.filter((item) =>
    item.status === "valid" &&
    item.type === "artifact_created" &&
    item.subjectId === "web_app"
  );
  const deployment = evidence.filter((item) =>
    item.status === "valid" &&
    item.type === "deployment_created" &&
    (!item.subjectId || item.subjectId === "web_app")
  );
  const indexHtml = evidence.filter((item) =>
    item.status === "valid" &&
    item.type === "file_written" &&
    normalizePath(item.subjectId).endsWith("index.html")
  );

  if (webAppArtifact.length === 0 || deployment.length === 0 || indexHtml.length === 0) return result;

  return {
    passed: true,
    evidenceIds: [...webAppArtifact, ...deployment, ...indexHtml].map((item) => item.id),
    reason:
      "Static web_app was deployed without an npm project: index.html, web_app artifact, and deployment evidence are present; pnpm build is not required."
  };
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function parseArtifactPayload(payloadJson: string): { outputKey?: string; artifactId?: string } {
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    return {
      outputKey: typeof parsed.outputKey === "string" ? parsed.outputKey : undefined,
      artifactId: typeof parsed.artifactId === "string" ? parsed.artifactId : undefined,
    };
  } catch {
    return {};
  }
}

export function findUnsupportedArtifactClaims(
  // `summary` is accepted (callers pass the real report) but deliberately NOT
  // scanned — see the note below.
  taskReport: { artifacts?: Record<string, string>; summary?: string } | undefined,
  evidence: Array<{ subjectId: string; payloadJson: string; status: string }>,
): string[] {
  if (!taskReport) return [];
  // Only the structured artifact map counts as a claim.
  //
  // The report's free-text summary used to be scanned as well, which failed an
  // entire task attempt over a typo in prose — or over a legitimate mention of an
  // artifact belonging to another conversation. That is disproportionate: output
  // bindings are built from `artifact_created` evidence and never from
  // self-report, so an id written in narrative text cannot influence the
  // pipeline. A live run failed its recovery task for exactly this reason (the
  // agent wrote its own review_report id one character short).
  //
  // Observability is not lost: context-trace-service still reports artifact ids
  // mentioned in agent messages as a `guessed_artifact_id` warning.
  const claimedIds = extractArtifactIds(Object.values(taskReport.artifacts ?? {}).join("\n"));
  if (claimedIds.length === 0) return [];

  const supportedIds = new Set<string>();
  for (const item of evidence) {
    if (item.status !== "valid") continue;
    if (/^art_[A-Za-z0-9_-]+$/.test(item.subjectId)) supportedIds.add(item.subjectId);
    try {
      const payload = JSON.parse(item.payloadJson) as Record<string, unknown>;
      if (typeof payload.artifactId === "string") supportedIds.add(payload.artifactId);
    } catch {
      // Invalid historical payloads cannot prove an artifact claim.
    }
  }
  return claimedIds.filter((artifactId) => !supportedIds.has(artifactId));
}

function isCompleteArtifact(content: import("@/shared/types").ArtifactContent): boolean {
  switch (content.type) {
    case "document":
      return content.content.trim().length > 0;
    case "web_app":
      return Boolean(
        content.entry &&
        Object.keys(content.files).length > 0 &&
        content.files[content.entry]?.trim()
      );
    case "image":
      return content.url.trim().length > 0;
    case "ppt":
      return content.slides.length > 0;
    default:
      return false;
  }
}
