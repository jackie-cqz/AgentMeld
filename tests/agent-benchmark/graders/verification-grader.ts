import type { BenchmarkGrader } from "./grader-types";
import { assertionResult } from "./grader-types";
import { findTasksByRole } from "./role-utils";

export const verificationStatusGrader: BenchmarkGrader = {
  type: "verification_status",
  grade(assertion, context) {
    if (assertion.type !== "verification_status") {
      throw new Error("verificationStatusGrader received an incompatible assertion.");
    }
    const tasks = assertion.role
      ? findTasksByRole(context.trace.tasks, assertion.role)
      : context.trace.tasks;
    const task = tasks.find((candidate) => {
      const latest = candidate.attempts.at(-1);
      if (latest?.verificationStatus !== assertion.expected) return false;
      return !assertion.warningCode
        || candidate.warnings.some((warning) => warning.code === assertion.warningCode);
    });
    const latest = task?.attempts.at(-1);

    return assertionResult(
      assertion,
      Boolean(task),
      task
        ? `${task.taskId} verification status is ${assertion.expected}`
          + (assertion.warningCode ? ` with warning ${assertion.warningCode}.` : ".")
        : `No matching task reached verification status ${assertion.expected}`
          + (assertion.warningCode ? ` with warning ${assertion.warningCode}.` : "."),
      task
        ? [{
            runId: context.trace.conductorRunId,
            taskId: task.taskId,
            attemptId: latest?.attemptId,
          }]
        : [],
    );
  },
};
