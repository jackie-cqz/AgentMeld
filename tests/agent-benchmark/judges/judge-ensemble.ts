import fs from "node:fs";
import path from "node:path";

import type { AgentBenchmarkCase } from "@/server/context-metrics/benchmark-types";

import { runCodexJudge, type RunJudgeOptions } from "./codex-judge";
import type { JudgeExecution, JudgePacket, JudgeResult } from "./judge-types";

type JudgeExecutor = typeof runCodexJudge;

export async function runJudgeEnsemble(
  benchmarkCase: AgentBenchmarkCase,
  packet: JudgePacket,
  options: RunJudgeOptions,
  repeat: number,
  execute: JudgeExecutor = runCodexJudge,
): Promise<JudgeExecution> {
  const count = options.mode === "api" ? Math.max(1, repeat) : 1;
  if (count === 1) return execute(benchmarkCase, packet, options);

  const samples: JudgeExecution[] = [];
  for (let index = 1; index <= count; index++) {
    samples.push(await execute(benchmarkCase, packet, {
      ...options,
      reportDir: path.join(options.reportDir, "judge-samples", String(index)),
      cacheSalt: `sample-${index}`,
    }));
  }
  const results = samples.flatMap((sample) => sample.status === "completed" && sample.result ? [sample.result] : []);
  if (results.length === 0) {
    const first = samples[0];
    return {
      ...first,
      error: samples.map((sample) => sample.error).filter(Boolean).join("; ") || "All Judge samples failed.",
      sampleResults: [],
      disagreement: false,
    };
  }

  const aggregate = aggregateJudgeResults(results, count);
  fs.mkdirSync(options.reportDir, { recursive: true });
  const packetPath = path.join(options.reportDir, "judge-packet.json");
  const resultPath = path.join(options.reportDir, "judge-result.json");
  fs.writeFileSync(packetPath, JSON.stringify(packet, null, 2), "utf-8");
  fs.writeFileSync(resultPath, JSON.stringify({ ...aggregate.result, samples: results }, null, 2), "utf-8");
  return {
    mode: options.mode,
    status: "completed",
    packetPath,
    resultPath,
    packetHash: packet.packetHash,
    result: aggregate.result,
    error: results.length === count ? null : `${count - results.length}/${count} Judge samples failed.`,
    fromCache: samples.every((sample) => sample.fromCache),
    sampleResults: results,
    disagreement: aggregate.disagreement,
  };
}

export function aggregateJudgeResults(
  results: JudgeResult[],
  expectedCount = results.length,
): { result: JudgeResult; disagreement: boolean } {
  if (results.length === 0) throw new Error("Cannot aggregate an empty Judge result set.");
  const sorted = [...results].sort((a, b) => a.weightedScore - b.weightedScore);
  const representative = sorted[Math.floor((sorted.length - 1) / 2)];
  const verdicts = new Set(results.map((result) => result.verdict));
  const disagreement = verdicts.size > 1 || results.length < expectedCount;
  const verdict = disagreement ? "needs_human_review" : majorityVerdict(results);
  return {
    disagreement,
    result: {
      ...representative,
      provider: `${representative.provider}-ensemble`,
      verdict,
      confidence: median(results.map((result) => result.confidence)),
      summary: disagreement
        ? `Judge samples disagreed (${results.map((result) => result.verdict).join(", ")}); human review required.`
        : `Judge ensemble (${results.length} samples): ${representative.summary}`,
      tokenUsage: {
        inputTokens: results.reduce((sum, result) => sum + (result.tokenUsage?.inputTokens ?? 0), 0),
        outputTokens: results.reduce((sum, result) => sum + (result.tokenUsage?.outputTokens ?? 0), 0),
      },
      estimatedCostUsd: results.reduce((sum, result) => sum + (result.estimatedCostUsd ?? 0), 0),
      createdAt: Date.now(),
    },
  };
}

function majorityVerdict(results: JudgeResult[]): JudgeResult["verdict"] {
  const counts = new Map<JudgeResult["verdict"], number>();
  for (const result of results) counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
