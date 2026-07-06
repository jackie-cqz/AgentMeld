// ---------------------------------------------------------------------------
// P6: Fixture Report Store — persistent storage for E2E run results
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { getDataDir } from "@/db/client";
import type { FixtureReportEntry, FixtureReportSummary } from "@/server/context-metrics/context-metrics-types";

const REPORTS_DIR = () => path.join(getDataDir(), "fixture-reports");

function ensureDir(): void {
  const dir = REPORTS_DIR();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Save a fixture run result to persistent storage. */
export function saveFixtureReport(entry: FixtureReportEntry): string {
  ensureDir();
  const filename = `report-${entry.fixtureId}-${entry.runId.slice(-8)}-${Date.now()}.json`;
  const filepath = path.join(REPORTS_DIR(), filename);
  fs.writeFileSync(filepath, JSON.stringify(entry, null, 2), "utf-8");
  return filename;
}

/** List all saved fixture reports (most recent first). */
export function listFixtureReports(limit = 20): Array<{ filename: string; entry: FixtureReportEntry }> {
  ensureDir();
  const files = fs.readdirSync(REPORTS_DIR())
    .filter((f) => f.startsWith("report-") && f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit);

  return files.map((f) => {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR(), f), "utf-8")) as FixtureReportEntry;
      return { filename: f, entry };
    } catch {
      return { filename: f, entry: null as unknown as FixtureReportEntry };
    }
  }).filter((r) => r.entry != null);
}

/** Build a summary from saved fixture reports. */
export function getFixtureReportSummary(): FixtureReportSummary {
  const reports = listFixtureReports(100);
  const entries = reports.map((r) => r.entry);
  const passed = entries.filter((e) => e.status === "passed").length;
  const failed = entries.filter((e) => e.status === "failed").length;
  const errors = entries.filter((e) => e.status === "error").length;

  return {
    generatedAt: Date.now(),
    totalFixtures: entries.length,
    passed,
    failed,
    errors,
    overallPassRate: entries.length > 0 ? Math.round((passed / entries.length) * 100) / 100 : 0,
    entries,
  };
}
