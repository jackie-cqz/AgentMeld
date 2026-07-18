// ---------------------------------------------------------------------------
// P4: Validator Registry — maps CriterionValidator types to validators
// ---------------------------------------------------------------------------

import type { CriterionValidator } from "@/shared/evidence-types";
import type { AcceptanceCriterionSpec } from "@/shared/types";
import { getArtifact } from "@/server/repositories";

export interface ValidationResult {
  passed: boolean;
  evidenceIds: string[];
  reason: string;
}

interface EvidenceRecord {
  id: string; type: string; subjectId: string; payloadJson: string; status: string;
}

/** Resolve the appropriate validator function for a given validator spec */
export function resolveValidator(validator: CriterionValidator): CriterionValidator {
  return validator; // Pass-through; dispatch happens in validateCriterion
}

/** Validate a single criterion against available evidence */
export function validateCriterion(
  criterion: AcceptanceCriterionSpec,
  _validator: CriterionValidator,
  evidence: EvidenceRecord[],
  taskReport: { artifacts?: Record<string, string>; summary?: string } | undefined
): ValidationResult {
  const v = criterion.validator;

  switch (v.type) {
    case "file_exists":
      return validateFileExists(v.path, evidence);
    case "file_changed":
      return validateFileChanged(v.path, evidence);
    case "command_exit":
      return validateCommandExit(v.command, v.expectedExitCode, evidence);
    case "artifact_exists":
      return validateArtifactExists(v.outputKey, v.artifactType, evidence, taskReport);
    case "deployment_created":
      return validateDeploymentCreated(v.outputKey, evidence);
    case "user_confirmation":
      return validateUserConfirmation(evidence);
    case "reviewer_verdict":
      // P4: reviewer_verdict cannot be auto-validated by code.
      // Required → needs_review (blocks task until reviewer resolves).
      // Optional → informational only, non-blocking.
      // NEVER auto-pass without evidence — that violates Evidence > declaration.
      return criterion.required
        ? { passed: false, evidenceIds: [], reason: "reviewer_verdict requires a Reviewer Agent — pending review" }
        : { passed: false, evidenceIds: [], reason: "reviewer_verdict for optional criterion — skipped (no evidence, non-blocking)" };
    default:
      return { passed: false, evidenceIds: [], reason: `Unknown validator type: ${(v as { type?: string }).type}` };
  }
}

function validateFileExists(path: string, evidence: EvidenceRecord[]): ValidationResult {
  const matched = evidence.filter(e => e.type === "file_written" && e.subjectId === path);
  if (matched.length > 0) {
    return { passed: true, evidenceIds: matched.map(e => e.id), reason: `File "${path}" was written.` };
  }
  return { passed: false, evidenceIds: [], reason: `File "${path}" was not created/modified in this attempt.` };
}

function validateFileChanged(path: string, evidence: EvidenceRecord[]): ValidationResult {
  const matched = evidence.filter(e => e.type === "file_written" && e.subjectId === path);
  if (matched.length > 0) {
    return { passed: true, evidenceIds: matched.map(e => e.id), reason: `File "${path}" was modified.` };
  }
  return { passed: false, evidenceIds: [], reason: `File "${path}" was not modified in this attempt.` };
}

function validateCommandExit(command: string, expectedExitCode: number, evidence: EvidenceRecord[]): ValidationResult {
  const matched = evidence.filter(e =>
    (e.type === "command_executed" || e.type === "test_executed") &&
    e.subjectId.includes(command.slice(0, 60))
  );
  if (matched.length === 0) {
    return { passed: false, evidenceIds: [], reason: `Command "${command}" was not executed in this attempt.` };
  }
  // Check exit code — look for evidence with matching exit code
  for (const ev of matched) {
    try {
      const p = JSON.parse(ev.payloadJson);
      if (p.exitCode === expectedExitCode) {
        return { passed: true, evidenceIds: [ev.id], reason: `Command "${command}" exited with ${expectedExitCode} as expected.` };
      }
    } catch { /* skip unparseable */ }
  }
  return { passed: false, evidenceIds: matched.map(e => e.id), reason: `Command "${command}" did not exit with ${expectedExitCode}.` };
}

function validateArtifactExists(
  outputKey: string, artifactType: string | undefined,
  evidence: EvidenceRecord[], _taskReport: { artifacts?: Record<string, string> } | undefined
): ValidationResult {
  // Check evidence for artifact_created matching outputKey
  const matched = evidence.filter(e =>
    e.type === "artifact_created" &&
    e.status === "valid" &&
    e.subjectId === outputKey
  );
  if (matched.length === 0) {
    return { passed: false, evidenceIds: [], reason: `No artifact_created evidence for outputKey "${outputKey}".` };
  }

  for (const item of [...matched].reverse()) {
    const artifactId = readArtifactId(item.payloadJson);
    const artifact = artifactId ? getArtifact(artifactId) : null;
    if (!artifact) continue;
    if (artifactType && artifact.type !== artifactType) continue;
    if (!hasArtifactContent(artifact.content)) continue;
    return {
      passed: true,
      evidenceIds: [item.id],
      reason: `Artifact "${outputKey}" has a complete persisted ${artifact.type} version.`
    };
  }
  if (matched.every((item) => !readArtifactId(item.payloadJson))) {
    return {
      passed: true,
      evidenceIds: matched.map((item) => item.id),
      reason: `Artifact "${outputKey}" is supported by legacy evidence without a persisted artifact reference.`
    };
  }
  return {
    passed: false,
    evidenceIds: matched.map(e => e.id),
    reason: `Artifact "${outputKey}" has no complete persisted version matching the expected type.`
  };
}

function readArtifactId(payloadJson: string): string | undefined {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    return typeof payload.artifactId === "string" ? payload.artifactId : undefined;
  } catch {
    return undefined;
  }
}

function hasArtifactContent(content: import("@/shared/types").ArtifactContent): boolean {
  if (content.type === "document") return content.content.trim().length > 0;
  if (content.type === "web_app") return Boolean(content.files[content.entry]?.trim());
  if (content.type === "image") return content.url.trim().length > 0;
  if (content.type === "ppt") return content.slides.length > 0;
  return false;
}

function validateDeploymentCreated(outputKey: string | undefined, evidence: EvidenceRecord[]): ValidationResult {
  const matched = evidence.filter(e =>
    e.type === "deployment_created" &&
    (!outputKey || e.subjectId === outputKey)
  );
  if (matched.length > 0) {
    return { passed: true, evidenceIds: matched.map(e => e.id), reason: `Deployment was created.` };
  }
  return { passed: false, evidenceIds: [], reason: `No deployment_created evidence found.` };
}

function validateUserConfirmation(evidence: EvidenceRecord[]): ValidationResult {
  const matched = evidence.filter(e => e.type === "user_answered" || e.type === "approval_resolved");
  if (matched.length > 0) {
    return { passed: true, evidenceIds: matched.map(e => e.id), reason: `User confirmation received.` };
  }
  return { passed: false, evidenceIds: [], reason: `No user confirmation evidence found.` };
}
