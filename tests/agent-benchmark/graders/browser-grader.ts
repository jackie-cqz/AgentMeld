import type { BenchmarkGrader } from "./grader-types";
import { assertionResult } from "./grader-types";

export const browserInteractionGrader: BenchmarkGrader = {
  type: "browser_interaction",
  grade(assertion, context) {
    if (assertion.type !== "browser_interaction") throw new Error("browserInteractionGrader received an incompatible assertion.");
    const result = context.runtimeValidation?.browsers.find((candidate) => candidate.scriptId === assertion.scriptId);
    if (!result) return assertionResult(assertion, false, `Browser script ${assertion.scriptId} was not executed.`);
    // Runtime validation owns the distinction between blocking same-origin
    // failures and observable third-party resource failures. Do not turn
    // retained non-blocking diagnostics back into hard failures here.
    const passed = result.status === "passed";
    const detail = passed
      ? `Browser script ${result.scriptId} passed ${result.steps.length} steps`
        + (result.failedRequests.length > 0
          ? `; ${result.failedRequests.length} non-blocking external request failure(s) were retained for diagnostics.`
          : " without blocking console, page, or request errors.")
      : `Browser script ${result.scriptId} failed: ${result.error ?? ([
          ...result.consoleErrors,
          ...result.pageErrors,
          ...result.failedRequests,
        ].join("; ") || result.status)}.`;
    return assertionResult(assertion, passed, detail, [{
      runId: context.trace.conductorRunId,
      url: result.previewUrl,
      filePath: result.screenshotPath ?? undefined,
    }]);
  },
};
