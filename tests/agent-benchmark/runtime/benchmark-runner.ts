import fs from "node:fs";
import path from "node:path";

import type { AgentBenchmarkCase } from "@/server/context-metrics/benchmark-types";

import {
  createErrorRunResult,
  evaluateBenchmarkTrace,
} from "../evaluate-case";
import type { E2ERunResult } from "../../e2e-runner/types";
import { ConversationDriver, type BenchmarkConversationStart } from "./conversation-driver";
import {
  BenchmarkEnvironmentManager,
  type BenchmarkEnvironment,
} from "./environment-manager";
import { RunWaiter, type RunWaitResult } from "./run-waiter";
import { TraceCollector, type BenchmarkTraceArchive } from "./trace-collector";
import { UserSimulator, type UserSimulatorAction } from "./user-simulator";

export interface BenchmarkTrialReport {
  schemaVersion: 1;
  caseId: string;
  trialIndex: number;
  environmentId: string;
  dataDir: string;
  workspacePath: string | null;
  conversationId: string | null;
  conductorRunId: string | null;
  taskAttemptIds: string[];
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  timedOut: boolean;
  runStatus: RunWaitResult["status"] | "not_started";
  userActions: UserSimulatorAction[];
  errors: string[];
  tracePath: string;
  reportPath: string;
  result: E2ERunResult;
}

export interface RunBenchmarkCaseOptions {
  trialIndex?: number;
  outputDir?: string;
  strategy?: string;
  signal?: AbortSignal;
  dependencies?: Partial<BenchmarkRunnerDependencies>;
}

export interface BenchmarkRunnerDependencies {
  environmentManager: BenchmarkEnvironmentManager;
  conversationDriver: ConversationDriver;
  runWaiter: RunWaiter;
  traceCollector: TraceCollector;
  userSimulator: UserSimulator;
}

export async function runBenchmarkCase(
  benchmarkCase: AgentBenchmarkCase,
  options: RunBenchmarkCaseOptions = {},
): Promise<BenchmarkTrialReport> {
  const startedAt = Date.now();
  const trialIndex = options.trialIndex ?? 1;
  const environmentManager = options.dependencies?.environmentManager ?? new BenchmarkEnvironmentManager();
  const environment = environmentManager.create(benchmarkCase.id, {
    baseDir: options.outputDir,
    trialIndex,
  });
  const conversationDriver = options.dependencies?.conversationDriver ?? new ConversationDriver();
  const runWaiter = options.dependencies?.runWaiter ?? new RunWaiter();
  const traceCollector = options.dependencies?.traceCollector ?? new TraceCollector();
  const userSimulator = options.dependencies?.userSimulator
    ?? new UserSimulator(benchmarkCase.runtime?.userScript);
  const tracePath = path.join(environment.reportDir, "trace.json");
  const reportPath = path.join(environment.reportDir, "report.json");

  let activated = false;
  let collectorStarted = false;
  let simulatorStarted = false;
  let conversation: BenchmarkConversationStart | null = null;
  let waitResult: RunWaitResult | null = null;
  let archive: BenchmarkTraceArchive = emptyTraceArchive();
  let result = createErrorRunResult(
    benchmarkCase.id,
    "not_started",
    startedAt,
    "Benchmark trial did not start.",
    options.strategy,
  );
  const errors: string[] = [];
  let finalReport: BenchmarkTrialReport | null = null;
  let reportWriteError: unknown;

  try {
    environmentManager.activate(environment);
    activated = true;
    traceCollector.start();
    collectorStarted = true;
    userSimulator.start();
    simulatorStarted = true;

    conversation = await conversationDriver.startCase(benchmarkCase);
    waitResult = await runWaiter.waitForEnd(conversation.conductorRunId, {
      timeoutMs: benchmarkCase.limits.maxDurationMs,
      signal: options.signal,
    });
    if (waitResult.error) errors.push(waitResult.error);

    archive = traceCollector.collect(conversation.conversationId, conversation.conductorRunId);
    if (archive.contextTrace && !waitResult.timedOut) {
      result = evaluateBenchmarkTrace(benchmarkCase, archive.contextTrace, {
        startedAt,
        finishedAt: Date.now(),
        strategy: options.strategy,
      });
      if (waitResult.status !== "complete") {
        result = {
          ...result,
          status: "error",
          error: waitResult.error ?? `Conductor run ended with status ${waitResult.status}.`,
        };
      }
    } else {
      const traceError = archive.traceError ?? "Context trace was not available.";
      const reason = waitResult.timedOut ? `${waitResult.error} ${traceError}` : traceError;
      result = createErrorRunResult(
        benchmarkCase.id,
        conversation.conductorRunId,
        startedAt,
        reason.trim(),
        options.strategy,
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    errors.push(detail);
    result = createErrorRunResult(
      benchmarkCase.id,
      conversation?.conductorRunId ?? "not_started",
      startedAt,
      detail,
      options.strategy,
    );
  } finally {
    const simulatorErrors = userSimulator.getErrors();
    errors.push(...simulatorErrors);
    if (simulatorErrors.length > 0) {
      result = {
        ...result,
        status: "error",
        warnings: [...result.warnings, ...simulatorErrors],
        error: result.error ?? simulatorErrors.join("; "),
      };
    }

    try {
      if (activated) {
        archive = traceCollector.collect(conversation?.conversationId ?? null, conversation?.conductorRunId ?? null);
      }
    } catch (error) {
      errors.push(`Final trace collection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      traceCollector.write(tracePath, archive);
    } catch (error) {
      errors.push(`Trace persistence failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (simulatorStarted) {
      try { userSimulator.stop(); } catch (error) {
        errors.push(`User simulator cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (collectorStarted) {
      try { traceCollector.stop(); } catch (error) {
        errors.push(`Trace collector cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (activated) {
      try { environmentManager.deactivate(); } catch (error) {
        errors.push(`Environment cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    finalReport = buildTrialReport({
      benchmarkCase,
      trialIndex,
      environment,
      conversation,
      waitResult,
      startedAt,
      userActions: userSimulator.getActions(),
      errors,
      archive,
      tracePath,
      reportPath,
      result,
    });
    try {
      writeJson(reportPath, finalReport);
    } catch (error) {
      reportWriteError = error;
    }
  }

  if (reportWriteError) {
    throw new Error(`Benchmark report could not be persisted to ${reportPath}: ${String(reportWriteError)}`);
  }
  if (!finalReport) throw new Error(`Benchmark report was not created for ${benchmarkCase.id}.`);
  return finalReport;
}

function buildTrialReport(input: {
  benchmarkCase: AgentBenchmarkCase;
  trialIndex: number;
  environment: BenchmarkEnvironment;
  conversation: BenchmarkConversationStart | null;
  waitResult: RunWaitResult | null;
  startedAt: number;
  userActions: UserSimulatorAction[];
  errors: string[];
  archive: BenchmarkTraceArchive;
  tracePath: string;
  reportPath: string;
  result: E2ERunResult;
}): BenchmarkTrialReport {
  const finishedAt = Date.now();
  return {
    schemaVersion: 1,
    caseId: input.benchmarkCase.id,
    trialIndex: input.trialIndex,
    environmentId: input.environment.id,
    dataDir: input.environment.dataDir,
    workspacePath: input.conversation?.workspacePath ?? null,
    conversationId: input.conversation?.conversationId ?? null,
    conductorRunId: input.conversation?.conductorRunId ?? null,
    taskAttemptIds: input.archive.taskAttemptIds,
    startedAt: input.startedAt,
    finishedAt,
    durationMs: finishedAt - input.startedAt,
    timedOut: input.waitResult?.timedOut ?? false,
    runStatus: input.waitResult?.status ?? "not_started",
    userActions: input.userActions,
    errors: [...new Set(input.errors.filter(Boolean))],
    tracePath: path.resolve(input.tracePath),
    reportPath: path.resolve(input.reportPath),
    result: input.result,
  };
}

function emptyTraceArchive(): BenchmarkTraceArchive {
  return {
    schemaVersion: 1,
    collectedAt: Date.now(),
    conversationId: null,
    conductorRunId: null,
    runs: [],
    taskAttemptIds: [],
    events: [],
    traceError: "Trial environment was not activated.",
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(temporaryPath, filePath);
}
