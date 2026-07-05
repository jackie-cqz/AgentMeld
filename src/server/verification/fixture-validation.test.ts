// ---------------------------------------------------------------------------
// P8: Fixture validation — structural checks run as part of test suite
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

interface FixtureTask {
  id: string;
  agentId: string;
  title?: string;
  dependsOn: string[];
  inputs?: Array<{ fromTaskId: string; outputId: string; required?: boolean }>;
  expectedOutputs: Array<{ id: string; type: string; required?: boolean }>;
  acceptanceCriteria?: Array<{ id: string; description: string; required?: boolean; validator: { type: string } }>;
}

interface Fixture {
  name: string;
  description: string;
  plan: { tasks: FixtureTask[] };
  expectedIncludedSources: string[];
  expectedOmittedSources: string[];
  expectedVerifiedOutputs: string[];
  expectedBlockedTasks: string[];
  expectedVerdicts: Array<{ taskId: string; criterionId: string; expectedStatus: string }>;
  failureScenarios: Array<{ name: string; expected: string; blockedTasks?: string[]; verdicts?: Array<{ criterionId: string; expectedStatus: string }> }>;
}

const FIXTURES_DIR = path.join(__dirname, "..", "..", "..", "tests", "fixtures", "evidence-context");

function loadFixtures(): Fixture[] {
  const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf-8")) as Fixture);
}

describe("P8 evidence-context fixtures", () => {
  const fixtures = loadFixtures();

  it("has at least one fixture", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fix of fixtures) {
    describe(fix.name, () => {
      it("has a name and description", () => {
        expect(fix.name.length).toBeGreaterThan(0);
        expect(fix.description.length).toBeGreaterThan(0);
      });

      it("has a valid plan with tasks", () => {
        expect(fix.plan.tasks.length).toBeGreaterThan(0);
        for (const t of fix.plan.tasks) {
          expect(t.id).toBeTruthy();
          expect(t.agentId).toBeTruthy();
        }
      });

      it("DAG has no unknown dependencies", () => {
        const taskIds = new Set(fix.plan.tasks.map((t) => t.id));
        for (const t of fix.plan.tasks) {
          for (const dep of t.dependsOn) {
            expect(taskIds.has(dep), `${t.id} depends on unknown ${dep}`).toBe(true);
          }
        }
      });

      it("expectedVerifiedOutputs reference real tasks and outputs", () => {
        const taskMap = new Map(fix.plan.tasks.map((t) => [t.id, t]));
        for (const eo of fix.expectedVerifiedOutputs) {
          const [taskId, outputKey] = eo.split(".");
          expect(taskMap.has(taskId), `task ${taskId} not in plan`).toBe(true);
          const task = taskMap.get(taskId)!;
          expect(task.expectedOutputs.some((o) => o.id === outputKey),
            `${taskId} does not declare output ${outputKey}`).toBe(true);
        }
      });

      it("expectedVerdicts reference real criteria", () => {
        const taskMap = new Map(fix.plan.tasks.map((t) => [t.id, t]));
        for (const v of fix.expectedVerdicts) {
          const task = taskMap.get(v.taskId);
          expect(task, `task ${v.taskId} not in plan`).toBeTruthy();
          if (task) {
            const crit = (task.acceptanceCriteria ?? []).find((c: { id: string }) => c.id === v.criterionId);
            expect(crit, `${v.taskId}.${v.criterionId} not in criteria`).toBeTruthy();
          }
          expect(["passed", "failed", "missing", "needs_review"]).toContain(v.expectedStatus);
        }
      });

      it("failure scenarios reference real tasks", () => {
        const taskIds = new Set(fix.plan.tasks.map((t) => t.id));
        for (const fs of fix.failureScenarios) {
          expect(fs.name.length).toBeGreaterThan(0);
          if (fs.blockedTasks) {
            for (const id of fs.blockedTasks) {
              expect(taskIds.has(id), `blocked task ${id} not in plan`).toBe(true);
            }
          }
        }
      });

      it("DAG isolation: tasks only input from direct dependencies", () => {
        const taskMap = new Map(fix.plan.tasks.map((t) => [t.id, t]));
        for (const t of fix.plan.tasks) {
          const directDeps = new Set(t.dependsOn);
          for (const input of t.inputs ?? []) {
            // Input must come from a task that this task depends on
            expect(directDeps.has(input.fromTaskId),
              `${t.id} has input from ${input.fromTaskId} but does NOT depend on it`
            ).toBe(true);
          }
        }
      });
    });
  }
});
