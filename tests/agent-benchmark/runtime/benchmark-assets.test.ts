import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentBenchmarkCase } from "@/server/context-metrics/benchmark-types";

import {
  captureMutationBaselines,
  collectMutationValidations,
  installHiddenBenchmarkAssets,
  prepareBenchmarkAssetBundle,
  seedBenchmarkAssetBundle,
} from "./benchmark-assets";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("benchmark asset isolation", () => {
  it("seeds public assets without exposing hidden verifier files", () => {
    const { repoRoot, workspacePath } = createFixtureTree();
    const bundle = { root: "tests/e2e-assets/example" };

    seedBenchmarkAssetBundle(workspacePath, bundle, repoRoot);

    expect(fs.readFileSync(path.join(workspacePath, "starter.txt"), "utf8")).toBe("public");
    expect(fs.existsSync(path.join(workspacePath, ".benchmark"))).toBe(false);

    const installed = installHiddenBenchmarkAssets(workspacePath, bundle, repoRoot);
    expect(fs.readFileSync(path.join(workspacePath, ".benchmark", "hidden", "verify.mjs"), "utf8"))
      .toContain("hidden verifier");

    installed.cleanup();
    expect(fs.existsSync(path.join(workspacePath, ".benchmark"))).toBe(false);
  });

  it("detects changed protected files and accepts files that remain absent", () => {
    const { workspacePath } = createFixtureTree();
    fs.writeFileSync(path.join(workspacePath, "protected.txt"), "original");
    const benchmarkCase = mutationCase();
    const baselines = captureMutationBaselines(workspacePath, benchmarkCase);

    fs.writeFileSync(path.join(workspacePath, "protected.txt"), "changed");
    const validations = collectMutationValidations(workspacePath, benchmarkCase, baselines);

    expect(validations).toEqual([
      expect.objectContaining({ path: "protected.txt", unchanged: false }),
      expect.objectContaining({ path: "never-created.txt", unchanged: true }),
    ]);
  });

  it("materializes and isolates generated public and hidden overlays", () => {
    const { repoRoot, workspacePath } = createFixtureTree();
    const assetRoot = path.join(repoRoot, "tests", "e2e-assets", "example");
    const setupScript = path.join(assetRoot, "setup.cjs");
    fs.writeFileSync(setupScript, [
      'const fs = require("node:fs");',
      'fs.mkdirSync("generated/public", { recursive: true });',
      'fs.mkdirSync("generated/hidden", { recursive: true });',
      'fs.writeFileSync("generated/public/input.txt", "generated public");',
      'fs.writeFileSync("generated/hidden/answer.txt", "generated hidden");',
    ].join("\n"));
    const bundle = {
      root: "tests/e2e-assets/example",
      setupCommands: [{ id: "generate", command: "node setup.cjs" }],
      generatedPublicDir: "generated/public",
      generatedHiddenDir: "generated/hidden",
    };

    prepareBenchmarkAssetBundle(bundle, repoRoot);
    seedBenchmarkAssetBundle(workspacePath, bundle, repoRoot);
    expect(fs.readFileSync(path.join(workspacePath, "input.txt"), "utf8")).toBe("generated public");
    expect(fs.existsSync(path.join(workspacePath, "answer.txt"))).toBe(false);

    const installed = installHiddenBenchmarkAssets(workspacePath, bundle, repoRoot);
    expect(fs.readFileSync(path.join(workspacePath, ".benchmark", "hidden", "answer.txt"), "utf8"))
      .toBe("generated hidden");
    installed.cleanup();
  });

  it("rejects public assets that try to occupy the reserved hidden verifier directory", () => {
    const { repoRoot, workspacePath } = createFixtureTree();
    const reserved = path.join(repoRoot, "tests", "e2e-assets", "example", "public", ".benchmark");
    fs.mkdirSync(reserved, { recursive: true });
    fs.writeFileSync(path.join(reserved, "leak.txt"), "hidden answer");

    expect(() => seedBenchmarkAssetBundle(
      workspacePath,
      { root: "tests/e2e-assets/example" },
      repoRoot,
    )).toThrow(/reserved \.benchmark directory/);
  });
});

function createFixtureTree(): { repoRoot: string; workspacePath: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-bench-assets-"));
  temporaryRoots.push(repoRoot);
  const assetRoot = path.join(repoRoot, "tests", "e2e-assets", "example");
  const workspacePath = path.join(repoRoot, "workspace");
  fs.mkdirSync(path.join(assetRoot, "public"), { recursive: true });
  fs.mkdirSync(path.join(assetRoot, "hidden"), { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(assetRoot, "public", "starter.txt"), "public");
  fs.writeFileSync(path.join(assetRoot, "hidden", "verify.mjs"), "// hidden verifier");
  return { repoRoot, workspacePath };
}

function mutationCase(): AgentBenchmarkCase {
  return {
    schemaVersion: 1,
    id: "mutation-case",
    title: "Mutation case",
    description: "Checks protected files.",
    category: "safety",
    prompt: "Repair only the requested file.",
    expectedRoles: ["frontend"],
    assertions: [{
      id: "protected",
      type: "no_forbidden_mutation",
      paths: ["protected.txt", "never-created.txt"],
      required: true,
    }],
    limits: { maxDurationMs: 1000 },
    tags: ["unit"],
  };
}
