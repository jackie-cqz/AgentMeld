import type { BenchmarkGrader } from "./grader-types";
import { assertionResult } from "./grader-types";
import { findTasksByRole } from "./role-utils";

export const buildSucceededGrader: BenchmarkGrader = {
  type: "build_succeeded",
  grade(assertion, context) {
    if (assertion.type !== "build_succeeded") throw new Error("buildSucceededGrader received an incompatible assertion.");
    const taskIds = assertion.role
      ? new Set(findTasksByRole(context.trace.tasks, assertion.role).map((task) => task.taskId))
      : null;
    const pattern = assertion.commandPattern?.toLowerCase();
    const candidates = (context.runtimeValidation?.builds ?? []).filter((build) =>
      (!taskIds || taskIds.has(build.taskId)) && (!pattern || build.command.toLowerCase().includes(pattern))
    );
    const passed = candidates.find((build) => build.status === "valid" && build.exitCode === 0 && !build.timedOut);
    if (passed) {
      return assertionResult(assertion, true, `Build command succeeded: ${passed.command}.`, [{
        runId: context.trace.conductorRunId,
        taskId: passed.taskId,
        evidenceId: passed.evidenceId,
      }]);
    }
    const failure = candidates.at(-1);
    return assertionResult(
      assertion,
      false,
      failure
        ? `Build did not succeed: ${failure.command} exited ${failure.exitCode}${failure.timedOut ? " after timeout" : ""}.`
        : `No matching build command evidence${assertion.commandPattern ? ` for ${assertion.commandPattern}` : ""} was found.`,
      failure ? [{ runId: context.trace.conductorRunId, taskId: failure.taskId, evidenceId: failure.evidenceId }] : [],
    );
  },
};
