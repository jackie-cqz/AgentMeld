import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { emptyRunMetrics } from "../evaluate-case";
import type { BenchmarkTrialReport } from "../runtime/benchmark-runner";
import { buildBenchmarkReport } from "./benchmark-report";
import { persistBenchmarkRun } from "./benchmark-run-reporter";
import { aggregateTrials } from "./metrics-aggregator";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("persistBenchmarkRun", () => {
  it("archives each trial with trace, events, browser evidence, screenshots, and judge files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-benchmark-report-"));
    roots.push(root);
    const source = path.join(root, "source");
    fs.mkdirSync(source, { recursive: true });
    const tracePath = path.join(source, "trace.json");
    const screenshotPath = path.join(source, "screen.png");
    const packetPath = path.join(source, "judge-packet.json");
    const resultPath = path.join(source, "judge-result.json");
    fs.writeFileSync(tracePath, JSON.stringify({ events: [{ type: "run.end", runId: "run_1" }] }), "utf-8");
    fs.writeFileSync(screenshotPath, Buffer.from([137, 80, 78, 71]));
    fs.writeFileSync(packetPath, JSON.stringify({ schemaVersion: 1 }), "utf-8");
    fs.writeFileSync(resultPath, JSON.stringify({ schemaVersion: 1 }), "utf-8");

    const trial = createTrial({ tracePath, screenshotPath, packetPath, resultPath });
    const report = buildBenchmarkReport([trial.result], "evidence_aware_context");
    const output = persistBenchmarkRun({
      runRoot: path.join(root, "run"),
      manifest: { schemaVersion: 1 },
      report,
      aggregate: aggregateTrials([trial]),
      trials: [trial],
    });
    const trialRoot = output.trialDirectories[0];
    expect(fs.existsSync(path.join(trialRoot, "result.json"))).toBe(true);
    expect(fs.existsSync(path.join(trialRoot, "context-trace.json"))).toBe(true);
    expect(fs.readFileSync(path.join(trialRoot, "events.jsonl"), "utf-8")).toContain("run.end");
    expect(fs.existsSync(path.join(trialRoot, "browser.json"))).toBe(true);
    expect(fs.existsSync(path.join(trialRoot, "screenshot-core.png"))).toBe(true);
    expect(fs.existsSync(path.join(trialRoot, "judge-packet.json"))).toBe(true);
    expect(fs.existsSync(path.join(trialRoot, "judge-result.json"))).toBe(true);
    expect(fs.existsSync(output.markdown)).toBe(true);
    const markdown = fs.readFileSync(output.markdown, "utf-8");
    expect(markdown).toContain("Task / tool retries: 0 / 0");
    expect(markdown).toContain("Blocked / propagated unverified outputs: 0 / 0");
  });
});

function createTrial(input: {
  tracePath: string;
  screenshotPath: string;
  packetPath: string;
  resultPath: string;
}): BenchmarkTrialReport {
  const result = {
    fixtureId: "archive-case",
    runId: "run_1",
    startedAt: 1,
    finishedAt: 2,
    status: "passed" as const,
    strategy: "evidence_aware_context",
    metrics: emptyRunMetrics(),
    assertionResults: [],
    artifacts: [],
    warnings: [],
  };
  return {
    schemaVersion: 1,
    caseId: "archive-case",
    trialIndex: 1,
    environmentId: "env_1",
    dataDir: "C:/tmp/data",
    workspacePath: "C:/tmp/workspace",
    conversationId: "conv_1",
    conductorRunId: "run_1",
    taskAttemptIds: ["att_1"],
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    timedOut: false,
    runStatus: "complete",
    userActions: [],
    errors: [],
    tracePath: input.tracePath,
    reportPath: "C:/tmp/report.json",
    result,
    runtimeValidation: {
      collectedAt: 2,
      artifacts: [], builds: [], deployments: [], previews: [],
      browsers: [{
        scriptId: "core", outputKey: "web_app", previewUrl: "http://localhost/preview", status: "passed",
        steps: [], consoleErrors: [], pageErrors: [], failedRequests: [], screenshotPath: input.screenshotPath, error: null,
      }],
      toolRejections: [],
      injectedFaults: [],
      approvals: [],
    },
    judge: {
      mode: "manual_codex", status: "completed", packetPath: input.packetPath, resultPath: input.resultPath,
      packetHash: "a".repeat(64), result: null, error: null, fromCache: false,
    },
    verdict: {
      deterministicVerdict: "passed", semanticVerdict: "passed", finalVerdict: "passed", reason: "passed",
    },
    injectedFaults: [],
  };
}
