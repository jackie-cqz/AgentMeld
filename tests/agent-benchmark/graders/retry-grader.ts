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

export const toolRetryBoundGrader: BenchmarkGrader = {
  type: "tool_retry_bound",
  grade(assertion, context) {
    if (assertion.type !== "tool_retry_bound") {
      throw new Error("toolRetryBoundGrader received an incompatible assertion.");
    }
    const taskIds = assertion.role
      ? new Set(findTasksByRole(context.trace.tasks, assertion.role).map((task) => task.taskId))
      : null;
    const calls = (context.runtimeValidation?.toolCalls ?? [])
      .filter((call) =>
        call.toolName === assertion.toolName
        && (!taskIds || (call.taskId != null && taskIds.has(call.taskId)))
        && (!assertion.commandPattern || safePatternTest(
          assertion.commandPattern,
          commandFromArgs(call.args),
        ))
      )
      .sort((left, right) => left.sequence - right.sequence);
    const passedMin = assertion.minCalls == null || calls.length >= assertion.minCalls;
    const passedMax = assertion.maxCalls == null || calls.length <= assertion.maxCalls;
    const firstFailureIndex = calls.findIndex((call) => call.status === "failed");
    const successAfterFailure = firstFailureIndex >= 0
      && calls.slice(firstFailureIndex + 1).some((call) => call.status === "succeeded");
    const passedRecovery = !assertion.requireFailureBeforeSuccess || successAfterFailure;

    return assertionResult(
      assertion,
      passedMin && passedMax && passedRecovery,
      `Observed ${calls.length} ${assertion.toolName} call(s); expected ${assertion.minCalls ?? 0}..${assertion.maxCalls ?? "unbounded"}`
        + (assertion.requireFailureBeforeSuccess
          ? `, failure-before-success=${successAfterFailure}.`
          : "."),
      calls.map((call) => ({
        runId: call.runId,
        taskId: call.taskId ?? undefined,
        attemptId: call.attemptId,
        toolCallId: call.callId,
      })),
    );
  },
};

function commandFromArgs(args: unknown): string {
  if (!args || typeof args !== "object" || !("command" in args)) return "";
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : "";
}

function safePatternTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
}
