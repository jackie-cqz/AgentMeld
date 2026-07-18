import type { BenchmarkGrader } from "./grader-types";
import { assertionResult } from "./grader-types";
import { findTasksByRole } from "./role-utils";

export const artifactValidGrader: BenchmarkGrader = {
  type: "artifact_valid",
  grade(assertion, context) {
    if (assertion.type !== "artifact_valid") throw new Error("artifactValidGrader received an incompatible assertion.");
    const taskIds = new Set(findTasksByRole(context.trace.tasks, assertion.role).map((task) => task.taskId));
    const records = context.runtimeValidation?.artifacts.filter((candidate) =>
      taskIds.has(candidate.taskId) &&
      candidate.outputKey === assertion.outputKey &&
      candidate.artifactType === assertion.artifactType
    ) ?? [];
    const record = records.at(-1);
    if (!record) return assertionResult(assertion, false, `No persisted ${assertion.artifactType} artifact was validated for ${assertion.outputKey}.`);
    const missingFiles = (assertion.requiredFiles ?? []).filter((file) => !record.files.includes(file));
    const missingPatterns = (assertion.requiredContentPatterns ?? []).filter((pattern) => {
      try {
        return !new RegExp(pattern, "i").test(record.contentText ?? "");
      } catch {
        return !(record.contentText ?? "").toLowerCase().includes(pattern.toLowerCase());
      }
    });
    const minBytes = assertion.minContentBytes ?? 1;
    const uniqueBindingOk = assertion.requireUniqueBinding !== true || records.length === 1;
    const passed =
      record.valid &&
      record.contentBytes >= minBytes &&
      missingFiles.length === 0 &&
      missingPatterns.length === 0 &&
      uniqueBindingOk;
    const details = [
      ...record.errors,
      ...(record.contentBytes < minBytes ? [`content is ${record.contentBytes} bytes; expected at least ${minBytes}`] : []),
      ...(missingFiles.length > 0 ? [`missing files: ${missingFiles.join(", ")}`] : []),
      ...(missingPatterns.length > 0 ? [`missing content patterns: ${missingPatterns.join(", ")}`] : []),
      ...(!uniqueBindingOk ? [`found ${records.length} active bindings; expected exactly one`] : []),
    ];
    return assertionResult(
      assertion,
      passed,
      passed ? `Artifact ${record.artifactId} is persisted and structurally valid.` : `Artifact ${record.artifactId} is invalid: ${details.join("; ")}.`,
      [{ runId: context.trace.conductorRunId, taskId: record.taskId, artifactId: record.artifactId }],
    );
  },
};
