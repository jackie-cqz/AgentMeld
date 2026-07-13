#!/usr/bin/env npx tsx

import { fetchAndEvaluateBenchmarkRun } from "../agent-benchmark/evaluate-case";
import { readBenchmarkCaseFile } from "../agent-benchmark/schemas/benchmark-case";

async function main(): Promise<void> {
  const runId = process.argv[2];
  const fixturePath = process.argv[3];
  if (!runId || !fixturePath) {
    console.error("Usage: pnpm e2e:fixture <runId> <fixturePath>");
    process.exitCode = 1;
    return;
  }

  let benchmarkCase;
  try {
    benchmarkCase = readBenchmarkCaseFile(fixturePath);
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
    return;
  }

  const result = await fetchAndEvaluateBenchmarkRun(runId, benchmarkCase);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "passed") process.exitCode = 1;
}

void main();
