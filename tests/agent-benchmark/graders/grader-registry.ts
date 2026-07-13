import type {
  AgentBenchmarkCase,
  AssertionResult,
  BenchmarkAssertion,
} from "@/server/context-metrics/benchmark-types";
import type { ContextTraceRunResponse } from "@/server/context-trace/context-trace-types";

import { artifactReadGrader } from "./artifact-read-grader";
import { dagEdgeGrader } from "./dag-grader";
import { deploymentReadyGrader } from "./deployment-grader";
import type { BenchmarkGrader } from "./grader-types";
import { outputBindingGrader } from "./output-binding-grader";
import { retryBoundGrader } from "./retry-grader";
import { roleExecutedGrader } from "./role-grader";
import { toolSucceededGrader } from "./tool-grader";

export class BenchmarkGraderRegistry {
  private readonly graders = new Map<BenchmarkAssertion["type"], BenchmarkGrader>();

  register(grader: BenchmarkGrader): void {
    if (this.graders.has(grader.type)) throw new Error(`Benchmark grader already registered: ${grader.type}`);
    this.graders.set(grader.type, grader);
  }

  has(type: BenchmarkAssertion["type"]): boolean {
    return this.graders.has(type);
  }

  grade(
    assertion: BenchmarkAssertion,
    benchmarkCase: AgentBenchmarkCase,
    trace: ContextTraceRunResponse,
  ): AssertionResult {
    const grader = this.graders.get(assertion.type);
    if (!grader) throw new Error(`No benchmark grader registered for assertion type: ${assertion.type}`);
    return grader.grade(assertion, { benchmarkCase, trace });
  }

  gradeAll(benchmarkCase: AgentBenchmarkCase, trace: ContextTraceRunResponse): AssertionResult[] {
    return benchmarkCase.assertions.map((assertion) => this.grade(assertion, benchmarkCase, trace));
  }
}

export function createDefaultBenchmarkGraderRegistry(): BenchmarkGraderRegistry {
  const registry = new BenchmarkGraderRegistry();
  registry.register(roleExecutedGrader);
  registry.register(dagEdgeGrader);
  registry.register(outputBindingGrader);
  registry.register(artifactReadGrader);
  registry.register(toolSucceededGrader);
  registry.register(deploymentReadyGrader);
  registry.register(retryBoundGrader);
  return registry;
}
