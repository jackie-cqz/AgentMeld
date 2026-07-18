import fs from "node:fs";
import path from "node:path";

const RUN_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export interface BenchmarkRunSummary {
  id: string;
  startedAt: number;
  finishedAt: number;
  caseIds: string[];
  strategies: string[];
  trialCount: number;
  passRate: number;
  finalStatus: "passed" | "failed" | "blocked" | "unknown";
  judgeMode: string;
  gitCommit: string;
  dirty: boolean;
}

export interface BenchmarkRunDetail extends BenchmarkRunSummary {
  manifest: Record<string, unknown>;
  report: Record<string, unknown>;
  aggregate: Record<string, unknown>;
  comparison: Record<string, unknown> | null;
  qualityGates: Record<string, unknown> | null;
  trials: Array<Record<string, unknown>>;
}

export function listBenchmarkRuns(dataDir = resolveBenchmarkRoot()): BenchmarkRunSummary[] {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .flatMap((entry) => {
      try {
        return [readBenchmarkRun(entry.name, dataDir)];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(toSummary);
}

export function getBenchmarkRun(runId: string, dataDir = resolveBenchmarkRoot()): BenchmarkRunDetail | null {
  if (!RUN_ID_PATTERN.test(runId)) return null;
  try {
    return readBenchmarkRun(runId, dataDir);
  } catch {
    return null;
  }
}

function readBenchmarkRun(runId: string, dataDir: string): BenchmarkRunDetail {
  const runRoot = path.join(dataDir, runId);
  const manifest = readRequiredObject(path.join(runRoot, "manifest.json"));
  const report = readRequiredObject(path.join(runRoot, "report.json"));
  const aggregate = readRequiredObject(path.join(runRoot, "aggregate-metrics.json"));
  const trials = Array.isArray(report.trials)
    ? report.trials.filter(isRecord)
    : readTrialResults(path.join(runRoot, "trials"));
  const startedAt = numberValue(manifest.startedAt);
  const finishedAt = numberValue(manifest.finishedAt);
  const trialCount = numberValue(aggregate.totalTrials, trials.length);
  const passRate = numberValue(aggregate.overallTrialSuccessRate);
  const verdicts = trials.map((trial) => isRecord(trial.verdict) ? String(trial.verdict.finalVerdict ?? "unknown") : "unknown");
  return {
    id: runId,
    startedAt,
    finishedAt,
    caseIds: stringArray(manifest.caseIds),
    strategies: stringArray(manifest.strategies),
    trialCount,
    passRate,
    finalStatus: verdicts.some((verdict) => verdict === "blocked")
      ? "blocked"
      : verdicts.length === 0
        ? "unknown"
        : verdicts.every((verdict) => verdict === "passed") ? "passed" : "failed",
    judgeMode: isRecord(manifest.judge) ? String(manifest.judge.mode ?? "off") : "off",
    gitCommit: isRecord(manifest.git) ? String(manifest.git.commit ?? "unknown") : "unknown",
    dirty: isRecord(manifest.git) ? Boolean(manifest.git.dirty) : true,
    manifest,
    report,
    aggregate,
    comparison: readOptionalObject(path.join(runRoot, "comparison.json")),
    qualityGates: readOptionalObject(path.join(runRoot, "quality-gates.json")),
    trials,
  };
}

function toSummary(detail: BenchmarkRunDetail): BenchmarkRunSummary {
  return {
    id: detail.id,
    startedAt: detail.startedAt,
    finishedAt: detail.finishedAt,
    caseIds: detail.caseIds,
    strategies: detail.strategies,
    trialCount: detail.trialCount,
    passRate: detail.passRate,
    finalStatus: detail.finalStatus,
    judgeMode: detail.judgeMode,
    gitCommit: detail.gitCommit,
    dirty: detail.dirty,
  };
}

function readTrialResults(root: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(root)) return [];
  const results: Array<Record<string, unknown>> = [];
  for (const caseEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!caseEntry.isDirectory()) continue;
    const caseRoot = path.join(root, caseEntry.name);
    for (const trialEntry of fs.readdirSync(caseRoot, { withFileTypes: true })) {
      if (!trialEntry.isDirectory()) continue;
      const value = readOptionalObject(path.join(caseRoot, trialEntry.name, "result.json"));
      if (value) results.push(value);
    }
  }
  return results;
}

function resolveBenchmarkRoot(): string {
  return path.join(process.env.AGENTMELD_DATA_DIR ?? path.join(process.cwd(), ".agentmeld-data"), "benchmark-runs");
}

function readRequiredObject(filePath: string): Record<string, unknown> {
  const value = readOptionalObject(filePath);
  if (!value) throw new Error(`Missing benchmark report file: ${filePath}`);
  return value;
}

function readOptionalObject(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  return isRecord(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
