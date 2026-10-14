import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createDefaultBenchmarkGraderRegistry } from "../../../tests/agent-benchmark/graders/grader-registry";
import { loadBenchmarkCases } from "../../../tests/agent-benchmark/schemas/benchmark-case";

const FIXTURES_DIR = path.join(__dirname, "..", "..", "..", "tests", "e2e-fixtures");

describe("structured E2E benchmark cases", () => {
  const cases = loadBenchmarkCases(FIXTURES_DIR);
  const registry = createDefaultBenchmarkGraderRegistry();

  it("has at least five schema-valid cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });

  it("has unique case ids", () => {
    const ids = cases.map((benchmarkCase) => benchmarkCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const benchmarkCase of cases) {
    describe(benchmarkCase.id, () => {
      it("uses schema version 1 and stable unique assertion ids", () => {
        expect(benchmarkCase.schemaVersion).toBe(1);
        const ids = benchmarkCase.assertions.map((assertion) => assertion.id);
        expect(ids.every((id) => id.length > 0)).toBe(true);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it("has a registered deterministic grader for every assertion", () => {
        for (const assertion of benchmarkCase.assertions) {
          expect(registry.has(assertion.type), assertion.id).toBe(true);
        }
      });

      it("contains required role and category-specific outcome assertions", () => {
        expect(benchmarkCase.assertions.some((assertion) => assertion.required && assertion.type === "role_executed")).toBe(true);
        if (benchmarkCase.category === "safety") {
          // A safety case must assert that its safety property is actually checked.
          // Two shapes are legitimate:
          //  - platform enforcement: the task has the agent attempt something
          //    forbidden or approval-gated and the platform blocks it
          //    -> tool_rejected / approval_resolved;
          //  - task compliance: the prompt forbids touching protected inputs and
          //    the case asserts they were left alone -> no_forbidden_mutation.
          // Demanding tool_rejected/approval_resolved for the second shape would
          // make a compliant agent fail the case, i.e. reward violating the prompt.
          expect(
            benchmarkCase.assertions.some((assertion) =>
              assertion.required && (
                assertion.type === "tool_rejected" ||
                assertion.type === "approval_resolved" ||
                assertion.type === "no_forbidden_mutation"
              )
            ),
            `${benchmarkCase.id}: a safety case needs a required tool_rejected, approval_resolved or no_forbidden_mutation assertion`
          ).toBe(true);
        } else if (benchmarkCase.category === "false_completion") {
          expect(benchmarkCase.assertions.some((assertion) => assertion.required && assertion.type === "warning_present")).toBe(true);
        } else {
          expect(benchmarkCase.assertions.some((assertion) => assertion.required && assertion.type === "output_binding")).toBe(true);
        }
      });
    });
  }
});
