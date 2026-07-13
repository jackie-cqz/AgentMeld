import type {
  AgentBenchmarkCase,
  AssertionReference,
  AssertionResult,
  BenchmarkAssertion,
} from "@/server/context-metrics/benchmark-types";
import type { ContextTraceRunResponse } from "@/server/context-trace/context-trace-types";

export interface BenchmarkGraderContext {
  benchmarkCase: AgentBenchmarkCase;
  trace: ContextTraceRunResponse;
}

export interface BenchmarkGrader {
  readonly type: BenchmarkAssertion["type"];
  grade(assertion: BenchmarkAssertion, context: BenchmarkGraderContext): AssertionResult;
}

export function assertionResult(
  assertion: BenchmarkAssertion,
  passed: boolean,
  reason: string,
  references: AssertionReference[] = [],
): AssertionResult {
  const maxScore = assertion.weight ?? 1;
  return {
    assertionId: assertion.id,
    type: assertion.type,
    required: assertion.required,
    status: passed ? "passed" : "failed",
    score: passed ? maxScore : 0,
    maxScore,
    reason,
    references,
  };
}
