import type { BenchmarkGrader } from "./grader-types";
import { assertionResult } from "./grader-types";

export const previewHttpGrader: BenchmarkGrader = {
  type: "preview_http",
  grade(assertion, context) {
    if (assertion.type !== "preview_http") throw new Error("previewHttpGrader received an incompatible assertion.");
    const expectedStatus = assertion.expectedStatus ?? 200;
    const minBodyBytes = assertion.minBodyBytes ?? 1;
    const candidates = (context.runtimeValidation?.previews ?? []).filter((preview) =>
      !assertion.outputKey || preview.outputKey === assertion.outputKey
    );
    const passed = candidates.find((preview) => preview.status === expectedStatus && preview.bodyBytes >= minBodyBytes && !preview.error);
    if (passed) {
      return assertionResult(assertion, true, `Preview returned HTTP ${passed.status} with ${passed.bodyBytes} bytes.`, [{
        runId: context.trace.conductorRunId,
        artifactId: passed.artifactId,
        url: passed.previewUrl,
      }]);
    }
    const failure = candidates.at(-1);
    return assertionResult(
      assertion,
      false,
      failure
        ? `Preview validation failed at ${failure.previewUrl}: ${failure.error ?? `HTTP ${failure.status}, ${failure.bodyBytes} bytes`}.`
        : "No real deployment preview was probed.",
      failure ? [{ runId: context.trace.conductorRunId, artifactId: failure.artifactId, url: failure.previewUrl }] : [],
    );
  },
};
