import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listAgents } from "@/server/repositories";
import { BENCHMARK_CASE_SCHEMA_VERSION, type AgentBenchmarkCase } from "@/server/context-metrics/benchmark-types";
import { JUDGE_PROMPT_VERSION } from "../judges/judge-rubric";
import { ROLE_CONTRACT_VERSION } from "@/server/prompt-layout/prompt-layout-builder";

export function buildBenchmarkManifest(input: {
  benchmarkRunId: string;
  cases: AgentBenchmarkCase[];
  strategies: string[];
  startedAt: number;
  finishedAt: number;
  judgeMode: string;
  judgeModel?: string;
  judgeRepeat?: number;
  judgePacketHashes?: string[];
  calibration?: unknown;
}) {
  const agents = listAgents().map((agent) => ({
    id: agent.id,
    name: agent.name,
    adapterName: agent.adapterName,
    modelProvider: agent.modelProvider,
    modelId: agent.modelId,
    temperature: null,
    temperatureSource: "provider_default",
    toolNames: [...agent.toolNames].sort(),
    promptHash: sha256(agent.systemPrompt),
  }));
  return {
    schemaVersion: 1,
    benchmarkRunId: input.benchmarkRunId,
    git: readGitMetadata(),
    agentMeldVersion: readPackageVersion(),
    nodeVersion: process.version,
    operatingSystem: `${os.platform()} ${os.release()} ${os.arch()}`,
    caseSchemaVersion: BENCHMARK_CASE_SCHEMA_VERSION,
    caseIds: input.cases.map((benchmarkCase) => benchmarkCase.id),
    caseHash: sha256(JSON.stringify(input.cases)),
    strategies: input.strategies,
    roleContractVersion: ROLE_CONTRACT_VERSION,
    agents,
    agentConfigHash: sha256(JSON.stringify(agents)),
    judge: {
      mode: input.judgeMode,
      model: input.judgeModel ?? null,
      provider: input.judgeMode === "api" ? "openai-compatible" : input.judgeMode === "manual_codex" ? "openai-codex-manual" : null,
      temperature: input.judgeMode === "api" ? 0 : null,
      repeat: input.judgeRepeat ?? 1,
      promptVersion: JUDGE_PROMPT_VERSION,
      rubricVersions: [...new Set(input.cases.map((benchmarkCase) => benchmarkCase.judge?.rubricVersion).filter(Boolean))],
      packetHashes: [...new Set(input.judgePacketHashes ?? [])],
      calibration: input.calibration ?? null,
    },
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  };
}

function readGitMetadata() {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf-8" }).trim() || "detached";
    const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf-8" }).trim();
    return { branch, commit, dirty: status.length > 0 };
  } catch {
    return { branch: "unknown", commit: "unknown", dirty: true };
  }
}

function readPackageVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
