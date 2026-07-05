#!/usr/bin/env npx tsx
// ---------------------------------------------------------------------------
// P8: Evidence Context Evaluator
//
// Usage: npx tsx scripts/evaluate-evidence-context.ts [fixture-path]
//
// Validates that a fixture's expectedIncludedSources, expectedOmittedSources,
// expectedVerifiedOutputs, expectedBlockedTasks, and expectedVerdicts are
// internally consistent and match the DAG structure described in the fixture.
//
// This is a structural/consistency check, not an end-to-end integration test.
// Full E2E would require running the actual Conductor with mock agents.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";

interface FixtureTask {
  id: string;
  agentId: string;
  title?: string;
  dependsOn: string[];
  inputs?: Array<{ fromTaskId: string; outputId: string; required?: boolean }>;
  expectedOutputs: Array<{ id: string; type: string; required?: boolean }>;
  acceptanceCriteria?: Array<{
    id: string;
    description: string;
    required?: boolean;
    validator: { type: string; [key: string]: unknown };
  }>;
}

interface FixtureScenario {
  name: string;
  expected: string;
  blockedTasks?: string[];
  verification?: string;
  verdicts?: Array<{ criterionId: string; expectedStatus: string }>;
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
  failureScenarios: FixtureScenario[];
}

interface EvalResult {
  fixture: string;
  pass: boolean;
  checks: Array<{ label: string; pass: boolean; detail: string }>;
}

function evaluate(fixture: Fixture): EvalResult {
  const checks: EvalResult["checks"] = [];
  const tasks = fixture.plan.tasks;
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // ── Check DAG consistency ──────────────────────────────────────────────
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!taskMap.has(dep)) {
        checks.push({ label: `DAG: ${t.id} depends on unknown ${dep}`, pass: false, detail: "missing dependency" });
      }
    }
  }

  // ── Expected outputs exist in plan ──────────────────────────────────────
  for (const eo of fixture.expectedVerifiedOutputs) {
    const [taskId, outputKey] = eo.split(".");
    const task = taskMap.get(taskId);
    if (!task) {
      checks.push({ label: `Expected output: ${eo}`, pass: false, detail: `task ${taskId} not in plan` });
      continue;
    }
    const output = task.expectedOutputs.find((o) => o.id === outputKey);
    checks.push({
      label: `Expected output: ${eo}`,
      pass: !!output,
      detail: output ? `${task.title} declares ${outputKey}` : `${task.title} does NOT declare ${outputKey}`,
    });
  }

  // ── Expected blocked tasks reference real tasks ─────────────────────────
  for (const bt of fixture.expectedBlockedTasks) {
    const idMatch = bt.match(/\b(t\d+)\b/g);
    if (idMatch) {
      for (const id of idMatch) {
        checks.push({
          label: `Blocked: ${bt.slice(0, 60)}`,
          pass: taskMap.has(id),
          detail: taskMap.has(id) ? `${id} exists in plan` : `${id} NOT in plan`,
        });
      }
    }
  }

  // ── Build DAG and check isolation ───────────────────────────────────────
  // For each task, check that it only receives inputs from its direct deps
  for (const t of tasks) {
    const directDeps = new Set(t.dependsOn);
    const allUpstream = new Set<string>();
    const collectUpstream = (taskId: string) => {
      const task = taskMap.get(taskId);
      if (!task) return;
      for (const dep of task.dependsOn) {
        if (!allUpstream.has(dep)) {
          allUpstream.add(dep);
          collectUpstream(dep);
        }
      }
    };
    collectUpstream(t.id);
    // Indirect upstream (not direct) should NOT appear as inputs
    for (const input of t.inputs ?? []) {
      if (allUpstream.has(input.fromTaskId) && !directDeps.has(input.fromTaskId)) {
        checks.push({
          label: `Isolation: ${t.id} input ${input.fromTaskId}.${input.outputId}`,
          pass: false,
          detail: `indirect dependency should not appear as input — only direct deps allowed`,
        });
      }
    }
  }

  // ── Expected included sources check ─────────────────────────────────────
  for (const src of fixture.expectedIncludedSources) {
    const parts = src.split(" → ");
    if (parts.length === 2) {
      const [from, to] = parts;
      const [fromTask, fromOutput] = from.split(".");
      checks.push({
        label: `Included: ${src}`,
        pass: taskMap.has(fromTask) && taskMap.has(to),
        detail: `${taskMap.has(fromTask) ? "✓" : "✗"} ${fromTask} → ${taskMap.has(to) ? "✓" : "✗"} ${to}`,
      });
    }
  }

  // ── Verdicts reference real criteria ────────────────────────────────────
  for (const v of fixture.expectedVerdicts) {
    const task = taskMap.get(v.taskId);
    if (!task) {
      checks.push({ label: `Verdict: ${v.taskId}.${v.criterionId}`, pass: false, detail: `task ${v.taskId} not in plan` });
      continue;
    }
    const crit = (task.acceptanceCriteria ?? []).find((c) => c.id === v.criterionId);
    checks.push({
      label: `Verdict: ${v.taskId}.${v.criterionId} → ${v.expectedStatus}`,
      pass: !!crit,
      detail: crit ? `criterion exists, expects ${v.expectedStatus}` : "criterion NOT in task",
    });
  }

  // ── Failure scenarios ───────────────────────────────────────────────────
  for (const fs of fixture.failureScenarios) {
    if (fs.blockedTasks) {
      for (const id of fs.blockedTasks) {
        checks.push({
          label: `Scenario "${fs.name}": blocks ${id}`,
          pass: taskMap.has(id),
          detail: taskMap.has(id) ? "exists" : "NOT in plan",
        });
      }
    }
    if (fs.verdicts) {
      for (const v of fs.verdicts) {
        checks.push({
          label: `Scenario "${fs.name}": verdict ${v.criterionId} → ${v.expectedStatus}`,
          pass: ["passed", "failed", "missing", "needs_review"].includes(v.expectedStatus),
          detail: `valid status: ${["passed", "failed", "missing", "needs_review"].includes(v.expectedStatus)}`,
        });
      }
    }
  }

  const pass = checks.every((c) => c.pass);
  return { fixture: fixture.name, pass, checks };
}

// ── Main ────────────────────────────────────────────────────────────────────

const fixturePath = process.argv[2] ?? path.join(__dirname, "..", "tests", "fixtures", "evidence-context", "todo-app-4-agent.json");

if (!fs.existsSync(fixturePath)) {
  console.error(`Fixture not found: ${fixturePath}`);
  process.exit(1);
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as Fixture;
const result = evaluate(fixture);

console.log(`\nFixture: ${result.fixture}`);
console.log(`Result:  ${result.pass ? "✅ PASS" : "❌ FAIL"}\n`);

let passed = 0;
let failed = 0;
for (const c of result.checks) {
  if (c.pass) {
    console.log(`  ✅ ${c.label}`);
    passed++;
  } else {
    console.log(`  ❌ ${c.label}`);
    console.log(`     ${c.detail}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${result.checks.length} total`);

if (!result.pass) process.exit(1);
