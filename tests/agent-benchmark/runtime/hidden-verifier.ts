import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";

import type {
  AgentBenchmarkCase,
  BenchmarkCommandVerifier,
  BenchmarkRuntimeValidation,
  BenchmarkStructuredOutputValidation,
  BenchmarkVerifierValidation,
  BenchmarkWorkspaceFileValidation,
  StructuredOutputAssertion,
  WorkspaceFileAssertion,
} from "@/server/context-metrics/benchmark-types";

import {
  collectMutationValidations,
  installHiddenBenchmarkAssets,
  resolveWorkspacePath,
  type BenchmarkMutationBaselines,
} from "./benchmark-assets";

const MAX_CAPTURE_BYTES = 64 * 1024;

export interface HiddenVerifierResult {
  verifiers: BenchmarkVerifierValidation[];
  workspaceFiles: BenchmarkWorkspaceFileValidation[];
  structuredOutputs: BenchmarkStructuredOutputValidation[];
  mutations: NonNullable<BenchmarkRuntimeValidation["mutations"]>;
}

export type BenchmarkCommandRunner = (
  verifier: BenchmarkCommandVerifier,
  workspacePath: string,
) => Promise<BenchmarkVerifierValidation>;

export class HiddenVerifierExecutor {
  constructor(
    private readonly commandRunner: BenchmarkCommandRunner = runVerifierCommand,
    private readonly repoRoot = process.cwd(),
  ) {}

  async run(
    benchmarkCase: AgentBenchmarkCase,
    workspacePath: string,
    baselines: BenchmarkMutationBaselines = {},
  ): Promise<HiddenVerifierResult> {
    const installed = installHiddenBenchmarkAssets(
      workspacePath,
      benchmarkCase.runtime?.assetBundle,
      this.repoRoot,
    );
    try {
      const verifiers: BenchmarkVerifierValidation[] = [];
      for (const verifier of benchmarkCase.runtime?.verifiers ?? []) {
        verifiers.push(await this.commandRunner(verifier, workspacePath));
      }
      return {
        verifiers,
        workspaceFiles: collectWorkspaceFiles(benchmarkCase, workspacePath),
        structuredOutputs: collectStructuredOutputs(benchmarkCase, workspacePath),
        mutations: collectMutationValidations(workspacePath, benchmarkCase, baselines),
      };
    } finally {
      installed.cleanup();
    }
  }
}

export async function runVerifierCommand(
  verifier: BenchmarkCommandVerifier,
  workspacePath: string,
): Promise<BenchmarkVerifierValidation> {
  const startedAt = Date.now();
  const timeoutMs = verifier.timeoutMs ?? 120_000;
  const expectedExitCode = verifier.expectedExitCode ?? 0;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(verifier.command, {
      cwd: workspacePath,
      shell: true,
      windowsHide: true,
      env: verifierEnvironment(),
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendLimited(stderr, chunk);
    });

    const finish = (exitCode: number | null, error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const passed = !timedOut && !error && exitCode === expectedExitCode;
      resolve({
        verifierId: verifier.id,
        command: verifier.command,
        status: passed ? "passed" : error ? "error" : "failed",
        exitCode,
        expectedExitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        error: timedOut ? `Verifier timed out after ${timeoutMs}ms.` : error,
      });
    };

    child.once("error", (error) => finish(null, error.message));
    child.once("close", (code) => finish(code, null));
  });
}

function collectWorkspaceFiles(
  benchmarkCase: AgentBenchmarkCase,
  workspacePath: string,
): BenchmarkWorkspaceFileValidation[] {
  const assertions = benchmarkCase.assertions.filter(
    (assertion): assertion is WorkspaceFileAssertion => assertion.type === "workspace_file",
  );
  return [...new Set(assertions.map((assertion) => assertion.path))].map((relativePath) => {
    try {
      const target = resolveWorkspacePath(workspacePath, relativePath);
      if (!fs.existsSync(target)) return missingWorkspaceFile(relativePath, "File does not exist.");
      const stat = fs.statSync(target);
      if (!stat.isFile()) return missingWorkspaceFile(relativePath, "Path is not a file.", true);
      const bytes = fs.readFileSync(target);
      return {
        path: relativePath,
        exists: true,
        isFile: true,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        contentText: decodeText(bytes),
        error: null,
      };
    } catch (error) {
      return missingWorkspaceFile(relativePath, error instanceof Error ? error.message : String(error));
    }
  });
}

function collectStructuredOutputs(
  benchmarkCase: AgentBenchmarkCase,
  workspacePath: string,
): BenchmarkStructuredOutputValidation[] {
  const assertions = benchmarkCase.assertions.filter(
    (assertion): assertion is StructuredOutputAssertion => assertion.type === "structured_output",
  );
  return assertions.map((assertion) => validateStructuredOutput(assertion, workspacePath));
}

function validateStructuredOutput(
  assertion: StructuredOutputAssertion,
  workspacePath: string,
): BenchmarkStructuredOutputValidation {
  const errors: string[] = [];
  const keys = new Set<string>();
  let recordCount = 0;
  try {
    const target = resolveWorkspacePath(workspacePath, assertion.path);
    const content = fs.readFileSync(target, "utf8");
    if (assertion.format === "json") {
      const value = JSON.parse(content) as unknown;
      const records = Array.isArray(value) ? value : [value];
      recordCount = records.length;
      validateRecordKeys(records, assertion.requiredKeys ?? [], keys, errors);
    } else if (assertion.format === "jsonl") {
      const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const records = lines.map((line, index) => {
        try { return JSON.parse(line) as unknown; } catch { throw new Error(`Invalid JSONL record at line ${index + 1}.`); }
      });
      recordCount = records.length;
      validateRecordKeys(records, assertion.requiredKeys ?? [], keys, errors);
    } else {
      const rows = parseCsv(content);
      if (rows.length === 0) throw new Error("CSV output is empty.");
      rows[0].forEach((key) => keys.add(key));
      recordCount = Math.max(0, rows.length - 1);
      if (rows.some((row) => row.length !== rows[0].length)) errors.push("CSV rows have inconsistent column counts.");
    }
    if (assertion.format === "csv") {
      for (const key of assertion.requiredKeys ?? []) {
        if (!keys.has(key)) errors.push(`Required key is missing: ${key}`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    path: assertion.path,
    format: assertion.format,
    valid: errors.length === 0,
    recordCount,
    keys: [...keys].sort(),
    errors,
  };
}

function validateRecordKeys(
  records: unknown[],
  requiredKeys: string[],
  keys: Set<string>,
  errors: string[],
): void {
  records.forEach((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      if (requiredKeys.length > 0) errors.push(`Record ${index + 1} is not an object.`);
      return;
    }
    Object.keys(record).forEach((key) => keys.add(key));
    for (const key of requiredKeys) {
      if (!(key in record)) errors.push(`Record ${index + 1} is missing required key: ${key}.`);
    }
  });
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (char === '"') {
      if (quoted && content[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && content[index + 1] === "\n") index++;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  row.push(field);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

function verifierEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "COMSPEC", "TEMP", "TMP",
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "VIRTUAL_ENV", "CONDA_PREFIX", "PYTHONPATH", "NODE_PATH",
  ];
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    CI: "1",
    AGENTMELD_BENCHMARK_VERIFIER: "1",
  };
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function appendLimited(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next, "utf8") <= MAX_CAPTURE_BYTES) return next;
  return Buffer.from(next, "utf8").subarray(0, MAX_CAPTURE_BYTES).toString("utf8") + "\n[truncated]";
}

function decodeText(value: Buffer): string | null {
  if (value.includes(0)) return null;
  return value.toString("utf8");
}

function missingWorkspaceFile(
  relativePath: string,
  error: string,
  exists = false,
): BenchmarkWorkspaceFileValidation {
  return {
    path: relativePath,
    exists,
    isFile: false,
    bytes: 0,
    sha256: null,
    contentText: null,
    error,
  };
}
