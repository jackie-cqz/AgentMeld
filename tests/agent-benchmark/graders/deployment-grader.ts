import type { BenchmarkGrader } from "./grader-types";
import { assertionResult } from "./grader-types";
import { findTasksByRole } from "./role-utils";

export const deploymentReadyGrader: BenchmarkGrader = {
  type: "deployment_ready",
  grade(assertion, context) {
    if (assertion.type !== "deployment_ready") throw new Error("deploymentReadyGrader received an incompatible assertion.");
    const tasks = assertion.role ? findTasksByRole(context.trace.tasks, assertion.role) : context.trace.tasks;

    for (const task of tasks) {
      const evidence = task.evidence.find((candidate) =>
        candidate.type === "deployment_created" &&
        candidate.status === "valid" &&
        (!assertion.outputKey || candidate.subjectId === assertion.outputKey)
      );
      const binding = assertion.outputKey
        ? task.producedBindings.find((candidate) =>
            candidate.outputKey === assertion.outputKey && candidate.artifactType === "web_app"
          )
        : task.producedBindings.find((candidate) => candidate.artifactType === "web_app");
      if (evidence && binding) {
        return assertionResult(
          assertion,
          true,
          `Deployment evidence and web_app binding are ready for ${binding.outputKey}.`,
          [{
            runId: context.trace.conductorRunId,
            taskId: task.taskId,
            evidenceId: evidence.evidenceId,
            artifactId: binding.artifactId,
            toolCallId: evidence.sourceId,
          }],
        );
      }
    }

    return assertionResult(
      assertion,
      false,
      `No valid deployment evidence with a matching web_app binding${assertion.outputKey ? ` for ${assertion.outputKey}` : ""} was found.`,
    );
  },
};
