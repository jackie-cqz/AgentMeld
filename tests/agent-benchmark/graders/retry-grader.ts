import type { BenchmarkGrader } from "./grader-types";
import { assertionResult } from "./grader-types";
import { findTasksByRole } from "./role-utils";

export const retryBoundGrader: BenchmarkGrader = {
  type: "retry_bound",
  grade(assertion, context) {
    if (assertion.type !== "retry_bound") throw new Error("retryBoundGrader received an incompatible assertion.");
    const tasks = assertion.role ? findTasksByRole(context.trace.tasks, assertion.role) : context.trace.tasks;
    const attempts = tasks.reduce((total, task) => total + task.attempts.length, 0);
    const passedMin = assertion.minAttempts == null || attempts >= assertion.minAttempts;
    const passedMax = assertion.maxAttempts == null || attempts <= assertion.maxAttempts;
    return assertionResult(
      assertion,
      passedMin && passedMax,
      `Observed ${attempts} attempt(s); expected ${assertion.minAttempts ?? 0}..${assertion.maxAttempts ?? "unbounded"}.`,
      tasks.map((task) => ({ runId: context.trace.conductorRunId, taskId: task.taskId, attemptId: task.attempts.at(-1)?.attemptId })),
    );
  },
};
