import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentBenchmarkCase } from "@/server/context-metrics/benchmark-types";

import { readBenchmarkCaseFile } from "../schemas/benchmark-case";
import { captureMutationBaselines, seedBenchmarkAssetBundle } from "./benchmark-assets";
import { HiddenVerifierExecutor } from "./hidden-verifier";

const temporaryRoots: string[] = [];
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HAS_PYTHON = spawnSync("python", ["--version"], { windowsHide: true }).status === 0;

afterEach(() => {
  delete process.env.AGENTMELD_TEST_SECRET;
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("HiddenVerifierExecutor", () => {
  it("runs hidden checks after the agent phase and returns deterministic validations", async () => {
    const { repoRoot, workspacePath } = createVerifierFixture();
    const benchmarkCase = verifierCase();
    seedBenchmarkAssetBundle(workspacePath, benchmarkCase.runtime?.assetBundle, repoRoot);
    fs.writeFileSync(path.join(workspacePath, "report.json"), JSON.stringify({ status: "ready" }));
    fs.writeFileSync(path.join(workspacePath, "protected.txt"), "stable");
    const baselines = captureMutationBaselines(workspacePath, benchmarkCase);
    process.env.AGENTMELD_TEST_SECRET = "must-not-leak";

    expect(fs.existsSync(path.join(workspacePath, ".benchmark"))).toBe(false);
    const result = await new HiddenVerifierExecutor(undefined, repoRoot)
      .run(benchmarkCase, workspacePath, baselines);

    expect(result.verifiers).toEqual([
      expect.objectContaining({ verifierId: "hidden-node", status: "passed", exitCode: 0 }),
    ]);
    expect(result.workspaceFiles).toEqual([
      expect.objectContaining({ path: "starter.txt", exists: true, isFile: true, bytes: 6 }),
    ]);
    expect(result.structuredOutputs).toEqual([
      expect.objectContaining({ path: "report.json", valid: true, keys: ["status"] }),
    ]);
    expect(result.mutations).toEqual([
      expect.objectContaining({ path: "protected.txt", unchanged: true }),
    ]);
    expect(fs.existsSync(path.join(workspacePath, ".benchmark"))).toBe(false);
  });

  it("records a non-zero verifier exit without throwing and still removes hidden files", async () => {
    const { repoRoot, workspacePath } = createVerifierFixture("process.exit(7);");
    const benchmarkCase = verifierCase();
    seedBenchmarkAssetBundle(workspacePath, benchmarkCase.runtime?.assetBundle, repoRoot);

    const result = await new HiddenVerifierExecutor(undefined, repoRoot)
      .run(benchmarkCase, workspacePath);

    expect(result.verifiers[0]).toMatchObject({ status: "failed", exitCode: 7, expectedExitCode: 0 });
    expect(fs.existsSync(path.join(workspacePath, ".benchmark"))).toBe(false);
  });

  it("requires every JSON record to contain the declared keys", async () => {
    const { repoRoot, workspacePath } = createVerifierFixture();
    const benchmarkCase = verifierCase();
    seedBenchmarkAssetBundle(workspacePath, benchmarkCase.runtime?.assetBundle, repoRoot);
    fs.writeFileSync(path.join(workspacePath, "report.json"), JSON.stringify([
      { status: "ready" },
      { message: "missing status" },
    ]));

    const result = await new HiddenVerifierExecutor(undefined, repoRoot)
      .run(benchmarkCase, workspacePath);

    expect(result.structuredOutputs[0]).toMatchObject({ valid: false, recordCount: 2 });
    expect(result.structuredOutputs[0].errors).toContain("Record 2 is missing required key: status.");
  });

  it("rejects the intentionally incomplete T02 starter with its real hidden corpus", async () => {
    const result = await runPromotedStarter("tb2d-regex-log");
    expect(result.verifiers[0]).toMatchObject({ verifierId: "regex-edge-cases", status: "failed" });
  });

  it.runIf(HAS_PYTHON)("rejects the intentionally incomplete T01 starter with its real hidden tests", async () => {
    const result = await runPromotedStarter("tb2d-cancel-async-tasks");
    expect(result.verifiers[0]).toMatchObject({ verifierId: "async-hidden-tests", status: "failed" });
  });
});

async function runPromotedStarter(caseId: string) {
  const benchmarkCase = readBenchmarkCaseFile(path.join(REPO_ROOT, "tests", "e2e-fixtures", `${caseId}.json`));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), `agentmeld-${caseId}-`));
  temporaryRoots.push(workspacePath);
  seedBenchmarkAssetBundle(workspacePath, benchmarkCase.runtime?.assetBundle, REPO_ROOT);
  const baselines = captureMutationBaselines(workspacePath, benchmarkCase);
  return new HiddenVerifierExecutor(undefined, REPO_ROOT).run(benchmarkCase, workspacePath, baselines);
}

function createVerifierFixture(script = `
  import fs from "node:fs";
  if (process.env.AGENTMELD_TEST_SECRET) throw new Error("secret leaked");
  if (!fs.existsSync("starter.txt")) throw new Error("public asset missing");
  if (!fs.existsSync(".benchmark/hidden/verify.mjs")) throw new Error("hidden asset missing");
  console.log("hidden verifier passed");
`): { repoRoot: string; workspacePath: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-hidden-verifier-"));
  temporaryRoots.push(repoRoot);
  const assetRoot = path.join(repoRoot, "tests", "e2e-assets", "example");
  const workspacePath = path.join(repoRoot, "workspace");
  fs.mkdirSync(path.join(assetRoot, "public"), { recursive: true });
  fs.mkdirSync(path.join(assetRoot, "hidden"), { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(assetRoot, "public", "starter.txt"), "public");
  fs.writeFileSync(path.join(assetRoot, "hidden", "verify.mjs"), script);
  return { repoRoot, workspacePath };
}

function verifierCase(): AgentBenchmarkCase {
  return {
    schemaVersion: 1,
    id: "hidden-verifier-case",
    title: "Hidden verifier case",
    description: "Validates hidden post-run checks.",
    category: "recovery",
    prompt: "Repair the starter project.",
    expectedRoles: ["frontend"],
    assertions: [
      { id: "hidden", type: "command_verifier", verifierId: "hidden-node", required: true },
      { id: "starter", type: "workspace_file", path: "starter.txt", minBytes: 6, required: true },
      { id: "report", type: "structured_output", path: "report.json", format: "json", requiredKeys: ["status"], required: true },
      { id: "protected", type: "no_forbidden_mutation", paths: ["protected.txt"], required: true },
    ],
    limits: { maxDurationMs: 1000 },
    runtime: {
      assetBundle: { root: "tests/e2e-assets/example" },
      verifiers: [{ id: "hidden-node", command: "node .benchmark/hidden/verify.mjs" }],
    },
    tags: ["unit"],
  };
}
