import type { BenchmarkGrader } from "./grader-types";
import { assertionResult } from "./grader-types";
import { findTasksByRole } from "./role-utils";

export const outputBindingGrader: BenchmarkGrader = {
  type: "output_binding",
  grade(assertion, context) {
    if (assertion.type !== "output_binding") throw new Error("outputBindingGrader received an incompatible assertion.");
    const outputKeys = new Set([assertion.outputKey, ...(assertion.aliases ?? [])]);
    for (const task of findTasksByRole(context.trace.tasks, assertion.role)) {
      const binding = task.producedBindings.find((candidate) =>
        outputKeys.has(candidate.outputKey) && candidate.artifactType === assertion.artifactType
      );
      if (binding) {
        return assertionResult(
          assertion,
          assertion.requiredAbsent !== true,
          assertion.requiredAbsent
            ? `${assertion.role} unexpectedly produced binding ${binding.outputKey} (${assertion.artifactType}).`
            : `${assertion.role} produced verified binding ${binding.outputKey} (${assertion.artifactType}).`,
          [{ runId: context.trace.conductorRunId, taskId: task.taskId, artifactId: binding.artifactId }],
        );
      }
    }
    return assertionResult(
      assertion,
      assertion.requiredAbsent === true,
      assertion.requiredAbsent
        ? `${assertion.role} produced no binding for ${[...outputKeys].join(" or ")} as expected.`
        : `${assertion.role} did not produce verified binding ${[...outputKeys].join(" or ")} (${assertion.artifactType}).`,
    );
  },
};
