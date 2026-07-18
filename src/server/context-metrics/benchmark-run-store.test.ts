import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getBenchmarkRun, listBenchmarkRuns } from "./benchmark-run-store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("benchmark run store", () => {
  it("lists persisted runs and keeps deterministic and semantic verdicts in trial detail", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-benchmark-store-"));
    roots.push(root);
    const runRoot = path.join(root, "bench_2");
    fs.mkdirSync(runRoot, { recursive: true });
    write(runRoot, "manifest.json", { startedAt: 20, finishedAt: 40, caseIds: ["todo"], strategies: ["evidence_aware_context"], judge: { mode: "manual_codex" }, git: { commit: "abc123", dirty: false } });
    write(runRoot, "aggregate-metrics.json", { totalTrials: 1, overallTrialSuccessRate: 1 });
    write(runRoot, "report.json", { trials: [{ caseId: "todo", verdict: { deterministicVerdict: "passed", semanticVerdict: "passed", finalVerdict: "passed" } }] });

    expect(listBenchmarkRuns(root)).toEqual([expect.objectContaining({ id: "bench_2", finalStatus: "passed", passRate: 1, judgeMode: "manual_codex" })]);
    expect(getBenchmarkRun("bench_2", root)?.trials).toHaveLength(1);
    expect(getBenchmarkRun("../outside", root)).toBeNull();
  });
});

function write(root: string, name: string, value: unknown) {
  fs.writeFileSync(path.join(root, name), JSON.stringify(value), "utf-8");
}
