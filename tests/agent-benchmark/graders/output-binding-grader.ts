import type { BenchmarkGrader } from "./grader-types";
import { assertionResult } from "./grader-types";
import { findTasksByRole } from "./role-utils";

export const outputBindingGrader: BenchmarkGrader = {
  type: "output_binding",
  grade(assertion, context) {
    if (assertion.type !== "output_binding") throw new Error("outputBindingGrader received an incompatible assertion.");
    for (const task of findTasksByRole(context.trace.tasks, assertion.role)) {
      const binding = task.producedBindings.find((candidate) =>
        candidate.outputKey === assertion.outputKey && candidate.artifactType === assertion.artifactType
      );
      if (binding) {
        return assertionResult(
          assertion,
          true,
          `${assertion.role} produced verified binding ${assertion.outputKey} (${assertion.artifactType}).`,
          [{ runId: context.trace.conductorRunId, taskId: task.taskId, artifactId: binding.artifactId }],
        );
      }
    }
    return assertionResult(
      assertion,
      false,
      `${assertion.role} did not produce verified binding ${assertion.outputKey} (${assertion.artifactType}).`,
    );
  },
};
