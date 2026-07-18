import fs from "node:fs";
import path from "node:path";

import type { AgentBenchmarkReport } from "@/server/context-metrics/benchmark-types";
import type { BenchmarkTrialReport } from "../runtime/benchmark-runner";
import { buildMarkdownReport } from "./markdown-reporter";
import type { BenchmarkAggregateReport } from "./metrics-aggregator";
import { writeJsonReport } from "./json-reporter";

export function persistBenchmarkRun(input: {
  runRoot: string;
  manifest: unknown;
  report: AgentBenchmarkReport;
  aggregate: BenchmarkAggregateReport;
  comparison?: unknown;
  trials: BenchmarkTrialReport[];
}) {
  fs.mkdirSync(input.runRoot, { recursive: true });
  const trialDirectories = input.trials.map((trial) => persistTrial(input.runRoot, trial));
  const files = {
    manifest: writeJsonReport(path.join(input.runRoot, "manifest.json"), input.manifest),
    report: writeJsonReport(path.join(input.runRoot, "report.json"), { ...input.report, trials: input.trials }),
    aggregate: writeJsonReport(path.join(input.runRoot, "aggregate-metrics.json"), input.aggregate),
    markdown: path.join(input.runRoot, "report.md"),
    comparison: input.comparison ? writeJsonReport(path.join(input.runRoot, "comparison.json"), input.comparison) : null,
  };
  fs.writeFileSync(files.markdown, buildMarkdownReport(input.report, input.aggregate, input.trials), "utf-8");
  return { ...files, trialDirectories };
}

function persistTrial(runRoot: string, trial: BenchmarkTrialReport): string {
  const trialId = `${String(trial.trialIndex).padStart(2, "0")}-${sanitizeSegment(trial.environmentId)}`;
  const trialRoot = path.join(runRoot, "trials", sanitizeSegment(trial.caseId), trialId);
  fs.mkdirSync(trialRoot, { recursive: true });

  writeJsonReport(path.join(trialRoot, "result.json"), trial);
  copyIfPresent(trial.tracePath, path.join(trialRoot, "context-trace.json"));
  writeEventArchive(trial.tracePath, path.join(trialRoot, "events.jsonl"));
  writeJsonReport(path.join(trialRoot, "browser.json"), trial.runtimeValidation?.browsers ?? []);

  for (const browser of trial.runtimeValidation?.browsers ?? []) {
    if (!browser.screenshotPath) continue;
    const suffix = browser.scriptId ? `-${sanitizeSegment(browser.scriptId)}` : "";
    copyIfPresent(browser.screenshotPath, path.join(trialRoot, `screenshot${suffix}.png`));
  }
  if (trial.judge?.packetPath) copyIfPresent(trial.judge.packetPath, path.join(trialRoot, "judge-packet.json"));
  if (trial.judge?.resultPath) copyIfPresent(trial.judge.resultPath, path.join(trialRoot, "judge-result.json"));
  return trialRoot;
}

function writeEventArchive(tracePath: string, destination: string): void {
  try {
    const trace = JSON.parse(fs.readFileSync(tracePath, "utf-8")) as { events?: unknown[] };
    const lines = (trace.events ?? []).map((event) => JSON.stringify(event)).join("\n");
    fs.writeFileSync(destination, lines ? `${lines}\n` : "", "utf-8");
  } catch {
    fs.writeFileSync(destination, "", "utf-8");
  }
}

function copyIfPresent(source: string, destination: string): void {
  if (!fs.existsSync(source)) return;
  fs.copyFileSync(source, destination);
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
