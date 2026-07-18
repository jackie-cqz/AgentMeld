import fs from "node:fs";
import path from "node:path";

import type { ExternalBenchmarkCaseResult, ExternalBenchmarkReport } from "./external-benchmark-types";

export function importTerminalBenchReport(inputPath: string, outputRoot = defaultOutputRoot()): ExternalBenchmarkReport {
  const source = path.resolve(inputPath);
  const parsed = JSON.parse(fs.readFileSync(source, "utf-8")) as unknown;
  const cases = parseCases(parsed);
  const id = `external_terminal_bench_${Date.now()}`;
  const passed = cases.filter((item) => item.status === "passed").length;
  const failed = cases.filter((item) => item.status === "failed").length;
  const errors = cases.filter((item) => item.status === "error").length;
  const report: ExternalBenchmarkReport = {
    schemaVersion: 1,
    id,
    kind: "terminal-bench",
    source,
    importedAt: Date.now(),
    summary: { total: cases.length, passed, failed, errors, passRate: cases.length ? passed / cases.length : 0 },
    cases,
    notice: "Terminal-Bench measures isolated terminal/tool execution. It is reported separately and does not replace AgentMeld collaboration, context, evidence, or artifact quality metrics.",
  };
  const destination = path.join(outputRoot, id, "report.json");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(report, null, 2), "utf-8");
  return report;
}

function parseCases(value: unknown): ExternalBenchmarkCaseResult[] {
  const record = isRecord(value) ? value : {};
  const sourceCases = Array.isArray(record.cases)
    ? record.cases
    : Array.isArray(record.results) ? record.results : [];
  return sourceCases.flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const rawStatus = String(entry.status ?? entry.result ?? "error").toLowerCase();
    const status = rawStatus === "passed" || rawStatus === "pass" || rawStatus === "success"
      ? "passed"
      : rawStatus === "failed" || rawStatus === "fail" ? "failed" : "error";
    return [{
      caseId: String(entry.caseId ?? entry.task_id ?? entry.id ?? `case-${index + 1}`),
      status,
      score: finiteNumber(entry.score),
      durationMs: finiteNumber(entry.durationMs ?? entry.duration_ms),
      metadata: entry,
    } satisfies ExternalBenchmarkCaseResult];
  });
}

function defaultOutputRoot(): string {
  return path.join(process.env.AGENTMELD_DATA_DIR ?? path.join(process.cwd(), ".agentmeld-data"), "external-benchmark-runs");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
