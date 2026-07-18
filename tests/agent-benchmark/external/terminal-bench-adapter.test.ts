import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { importTerminalBenchReport } from "./terminal-bench-adapter";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Terminal-Bench result adapter", () => {
  it("imports external results into a separate report namespace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-external-bench-"));
    roots.push(root);
    const source = path.join(root, "terminal-bench.json");
    fs.writeFileSync(source, JSON.stringify({ results: [{ task_id: "build-app", status: "passed" }, { task_id: "repair", status: "failed" }] }), "utf-8");
    const report = importTerminalBenchReport(source, path.join(root, "external"));
    expect(report.summary).toMatchObject({ total: 2, passed: 1, failed: 1, passRate: 0.5 });
    expect(report.notice).toContain("does not replace AgentMeld collaboration");
    expect(fs.existsSync(path.join(root, "external", report.id, "report.json"))).toBe(true);
  });
});
