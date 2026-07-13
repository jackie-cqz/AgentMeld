import type { BenchmarkGrader } from "./grader-types";
import { assertionResult } from "./grader-types";
import { findTasksByRole } from "./role-utils";

export const roleExecutedGrader: BenchmarkGrader = {
  type: "role_executed",
  grade(assertion, context) {
    if (assertion.type !== "role_executed") throw new Error("roleExecutedGrader received an incompatible assertion.");
    const tasks = findTasksByRole(context.trace.tasks, assertion.role);
    const mustComplete = assertion.mustComplete ?? true;
    const matching = tasks.find((task) =>
      !mustComplete || task.attempts.some((attempt) => attempt.executionStatus === "reported_complete")
    );
    const references = matching
      ? [{
          runId: context.trace.conductorRunId,
          taskId: matching.taskId,
          attemptId: matching.attempts.at(-1)?.attemptId,
        }]
      : [];
    return assertionResult(
      assertion,
      !!matching,
      matching
        ? `${assertion.role} executed task ${matching.taskId}${mustComplete ? " and reported completion" : ""}.`
        : `No ${mustComplete ? "completed " : ""}task was found for role ${assertion.role}.`,
      references,
    );
  },
};
