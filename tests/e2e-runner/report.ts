#!/usr/bin/env npx tsx

import * as path from "node:path";

import { fetchAndEvaluateBenchmarkRun } from "../agent-benchmark/evaluate-case";
import {
  loadBenchmarkCases,
  readBenchmarkCaseFile,
} from "../agent-benchmark/schemas/benchmark-case";

const FIXTURES_DIR = path.join(__dirname, "..", "e2e-fixtures");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fixtureArg = args.indexOf("--fixture");
  const runIdArg = args.indexOf("--run");

  if (runIdArg >= 0 && fixtureArg >= 0) {
    const runId = args[runIdArg + 1];
    const fixturePath = args[fixtureArg + 1];
    if (!runId || !fixturePath) {
      console.error("Usage: pnpm e2e:report --run <runId> --fixture <path>");
      process.exitCode = 1;
      return;
    }
    try {
      const benchmarkCase = readBenchmarkCaseFile(fixturePath);
      const result = await fetchAndEvaluateBenchmarkRun(runId, benchmarkCase);
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "passed") process.exitCode = 1;
    } catch (error) {
      console.error(String(error));
      process.exitCode = 1;
    }
    return;
  }

  try {
    const cases = loadBenchmarkCases(FIXTURES_DIR);
    console.log(JSON.stringify({
      generatedAt: Date.now(),
      totalFixtures: cases.length,
      fixtures: cases.map((benchmarkCase) => ({
        id: benchmarkCase.id,
        title: benchmarkCase.title,
        description: benchmarkCase.description,
        category: benchmarkCase.category,
        expectedRoles: benchmarkCase.expectedRoles,
        assertionCount: benchmarkCase.assertions.length,
        requiredAssertionCount: benchmarkCase.assertions.filter((assertion) => assertion.required).length,
      })),
      note: "Evaluation requires a completed run. Use --run <runId> --fixture <path>.",
    }, null, 2));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}

void main();
