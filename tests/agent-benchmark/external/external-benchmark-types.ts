export type ExternalBenchmarkKind = "terminal-bench" | "swe-bench" | "other";

export interface ExternalBenchmarkCaseResult {
  caseId: string;
  status: "passed" | "failed" | "error";
  score?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ExternalBenchmarkReport {
  schemaVersion: 1;
  id: string;
  kind: ExternalBenchmarkKind;
  source: string;
  importedAt: number;
  summary: {
    total: number;
    passed: number;
    failed: number;
    errors: number;
    passRate: number;
  };
  cases: ExternalBenchmarkCaseResult[];
  notice: string;
}
