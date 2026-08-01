import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type {
  AgentBenchmarkCase,
  BenchmarkAssetBundle,
  BenchmarkMutationValidation,
  NoForbiddenMutationAssertion,
} from "@/server/context-metrics/benchmark-types";

export interface BenchmarkMutationBaseline {
  exists: boolean;
  sha256: string | null;
}

export type BenchmarkMutationBaselines = Record<string, BenchmarkMutationBaseline>;

export function seedBenchmarkAssetBundle(
  workspacePath: string,
  bundle: BenchmarkAssetBundle | undefined,
  repoRoot = process.cwd(),
): void {
  if (!bundle) return;
  const assetRoot = resolveAssetRoot(bundle, repoRoot);
  const publicRoot = resolveInside(assetRoot, bundle.publicDir ?? "public", "public asset directory");
  if (!fs.existsSync(publicRoot) || !fs.statSync(publicRoot).isDirectory()) {
    throw new Error(`Benchmark public asset directory is missing: ${publicRoot}`);
  }
  copyDirectory(publicRoot, path.resolve(workspacePath));
  if (bundle.generatedPublicDir) {
    const generatedPublicRoot = resolveInside(assetRoot, bundle.generatedPublicDir, "generated public asset directory");
    assertDirectoryExists(generatedPublicRoot, "Benchmark generated public asset directory");
    copyDirectory(generatedPublicRoot, path.resolve(workspacePath));
  }
}

export function prepareBenchmarkAssetBundle(
  bundle: BenchmarkAssetBundle | undefined,
  repoRoot = process.cwd(),
): void {
  if (!bundle?.setupCommands?.length) return;
  const assetRoot = resolveAssetRoot(bundle, repoRoot);
  for (const setup of bundle.setupCommands) {
    const result = spawnSync(setup.command, {
      cwd: assetRoot,
      shell: true,
      windowsHide: true,
      timeout: setup.timeoutMs ?? 120_000,
      encoding: "utf8",
      env: fixtureSetupEnvironment(),
    });
    if (result.error || result.status !== 0) {
      const detail = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n").trim();
      throw new Error(`Benchmark asset setup failed (${setup.id}): ${detail || `exit ${String(result.status)}`}`);
    }
  }
}

export function installHiddenBenchmarkAssets(
  workspacePath: string,
  bundle: BenchmarkAssetBundle | undefined,
  repoRoot = process.cwd(),
): { hiddenDir: string | null; cleanup: () => void } {
  if (!bundle) return { hiddenDir: null, cleanup: () => undefined };
  const workspaceRoot = path.resolve(workspacePath);
  const benchmarkRoot = resolveInside(workspaceRoot, ".benchmark", "benchmark verifier directory");
  const hiddenDestination = path.join(benchmarkRoot, "hidden");
  fs.rmSync(benchmarkRoot, { recursive: true, force: true });
  const assetRoot = resolveAssetRoot(bundle, repoRoot);
  const hiddenSource = resolveInside(assetRoot, bundle.hiddenDir ?? "hidden", "hidden asset directory");
  if (!fs.existsSync(hiddenSource) || !fs.statSync(hiddenSource).isDirectory()) {
    throw new Error(`Benchmark hidden asset directory is missing: ${hiddenSource}`);
  }
  copyDirectory(hiddenSource, hiddenDestination);
  if (bundle.generatedHiddenDir) {
    const generatedHiddenRoot = resolveInside(assetRoot, bundle.generatedHiddenDir, "generated hidden asset directory");
    assertDirectoryExists(generatedHiddenRoot, "Benchmark generated hidden asset directory");
    copyDirectory(generatedHiddenRoot, hiddenDestination);
  }
  return {
    hiddenDir: hiddenDestination,
    cleanup: () => fs.rmSync(benchmarkRoot, { recursive: true, force: true }),
  };
}

export function captureMutationBaselines(
  workspacePath: string,
  benchmarkCase: AgentBenchmarkCase,
): BenchmarkMutationBaselines {
  const paths = benchmarkCase.assertions.flatMap((assertion) =>
    assertion.type === "no_forbidden_mutation" ? assertion.paths : []);
  return Object.fromEntries([...new Set(paths)].map((relativePath) => [
    relativePath,
    inspectWorkspaceFile(workspacePath, relativePath),
  ]));
}

export function collectMutationValidations(
  workspacePath: string,
  benchmarkCase: AgentBenchmarkCase,
  baselines: BenchmarkMutationBaselines,
): BenchmarkMutationValidation[] {
  const assertions = benchmarkCase.assertions.filter(
    (assertion): assertion is NoForbiddenMutationAssertion => assertion.type === "no_forbidden_mutation",
  );
  const paths = [...new Set(assertions.flatMap((assertion) => assertion.paths))];
  return paths.map((relativePath) => {
    try {
      const before = baselines[relativePath] ?? { exists: false, sha256: null };
      const after = inspectWorkspaceFile(workspacePath, relativePath);
      return {
        path: relativePath,
        beforeSha256: before.sha256,
        afterSha256: after.sha256,
        unchanged: before.exists === after.exists && before.sha256 === after.sha256,
        error: null,
      };
    } catch (error) {
      return {
        path: relativePath,
        beforeSha256: baselines[relativePath]?.sha256 ?? null,
        afterSha256: null,
        unchanged: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export function resolveWorkspacePath(workspacePath: string, relativePath: string): string {
  return resolveInside(path.resolve(workspacePath), relativePath, "workspace path");
}

function resolveAssetRoot(bundle: BenchmarkAssetBundle, repoRoot: string): string {
  const allowedRoot = path.resolve(repoRoot, "tests", "e2e-assets");
  const assetRoot = path.resolve(repoRoot, bundle.root);
  const relative = path.relative(allowedRoot, assetRoot);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Benchmark asset bundle must be a child of ${allowedRoot}: ${bundle.root}`);
  }
  return assetRoot;
}

function resolveInside(root: string, relativePath: string, label: string): string {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its root: ${relativePath}`);
  }
  return target;
}

function copyDirectory(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".benchmark") {
      throw new Error(`Benchmark public assets may not use the reserved .benchmark directory: ${source}`);
    }
    if (entry.isSymbolicLink()) throw new Error(`Benchmark assets may not contain symbolic links: ${path.join(source, entry.name)}`);
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function assertDirectoryExists(directory: string, label: string): void {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`${label} is missing: ${directory}`);
  }
}

function fixtureSetupEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "COMSPEC", "TEMP", "TMP",
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "VIRTUAL_ENV", "CONDA_PREFIX", "PYTHONPATH", "NODE_PATH",
  ];
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", CI: "1", AGENTMELD_BENCHMARK_SETUP: "1" };
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function inspectWorkspaceFile(workspacePath: string, relativePath: string): BenchmarkMutationBaseline {
  const target = resolveWorkspacePath(workspacePath, relativePath);
  if (!fs.existsSync(target)) return { exists: false, sha256: null };
  if (!fs.statSync(target).isFile()) {
    throw new Error(`Protected path is not a file: ${relativePath}`);
  }
  return {
    exists: true,
    sha256: createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
  };
}
