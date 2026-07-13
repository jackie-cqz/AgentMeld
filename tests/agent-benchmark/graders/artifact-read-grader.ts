import type { BenchmarkGrader } from "./grader-types";
import { assertionResult } from "./grader-types";
import { findTasksByRole } from "./role-utils";

export const artifactReadGrader: BenchmarkGrader = {
  type: "artifact_read",
  grade(assertion, context) {
    if (assertion.type !== "artifact_read") throw new Error("artifactReadGrader received an incompatible assertion.");
    const producerTaskIds = new Set(findTasksByRole(context.trace.tasks, assertion.producerRole).map((task) => task.taskId));
    const requireVerified = assertion.requireVerifiedBinding ?? true;

    for (const task of findTasksByRole(context.trace.tasks, assertion.consumerRole)) {
      const input = task.consumedInputs.find((candidate) =>
        producerTaskIds.has(candidate.fromTaskId) &&
        candidate.outputKey === assertion.outputKey &&
        candidate.readByCurrentAttempt &&
        (!requireVerified || candidate.bindingVerified)
      );
      if (input) {
        return assertionResult(
          assertion,
          true,
          `${assertion.consumerRole} read ${assertion.producerRole}.${assertion.outputKey}.`,
          [{ runId: context.trace.conductorRunId, taskId: task.taskId, artifactId: input.artifactId }],
        );
      }
    }

    return assertionResult(
      assertion,
      false,
      `${assertion.consumerRole} did not read ${requireVerified ? "verified " : ""}${assertion.producerRole}.${assertion.outputKey}.`,
    );
  },
};
