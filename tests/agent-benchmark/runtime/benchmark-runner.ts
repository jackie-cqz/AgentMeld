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
import { collectRuntimeValidation } from "./runtime-validation-collector";
import { buildJudgePacket } from "../judges/judge-packet-builder";
import { runJudgeEnsemble } from "../judges/judge-ensemble";
import { composeVerdict } from "../judges/verdict-composer";
import type { JudgeExecution, JudgeMode } from "../judges/judge-types";
import { FaultInjector } from "./fault-injector";
import { UserSimulator, type UserSimulatorAction } from "./user-simulator";
import { HiddenVerifierExecutor } from "./hidden-verifier";

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
  runtimeValidation: import("@/server/context-metrics/benchmark-types").BenchmarkRuntimeValidation | null;
  judge: JudgeExecution | null;
  verdict: import("../judges/judge-types").ComposedVerdict;
  injectedFaults: import("@/server/context-metrics/benchmark-types").BenchmarkFaultRecord[];
}

export interface RunBenchmarkCaseOptions {
  trialIndex?: number;
  outputDir?: string;
  strategy?: string;
  signal?: AbortSignal;
  dependencies?: Partial<BenchmarkRunnerDependencies>;
  judgeMode?: JudgeMode;
  judgeModel?: string;
  judgeImportPath?: string;
  judgeRepeat?: number;
  maxDurationMs?: number;
  maxCostUsd?: number;
}

export interface BenchmarkRunnerDependencies {
  environmentManager: BenchmarkEnvironmentManager;
  conversationDriver: ConversationDriver;
  runWaiter: RunWaiter;
  traceCollector: TraceCollector;
  userSimulator: UserSimulator;
  verifierExecutor: HiddenVerifierExecutor;
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
  const verifierExecutor = options.dependencies?.verifierExecutor ?? new HiddenVerifierExecutor();
  const userSimulator = options.dependencies?.userSimulator
    ?? new UserSimulator(benchmarkCase.runtime?.userScript);
  const faultInjector = new FaultInjector(benchmarkCase.runtime?.faults);
  const tracePath = path.join(environment.reportDir, "trace.json");
  const reportPath = path.join(environment.reportDir, "report.json");

  let activated = false;
  let collectorStarted = false;
  let simulatorStarted = false;
  let conversation: BenchmarkConversationStart | null = null;
  let waitResult: RunWaitResult | null = null;
  let archive: BenchmarkTraceArchive = emptyTraceArchive();
  let runtimeValidation: import("@/server/context-metrics/benchmark-types").BenchmarkRuntimeValidation | null = null;
  let judge: JudgeExecution | null = null;
  let result = createErrorRunResult(
    benchmarkCase.id,
    "not_started",
    startedAt,
    "Benchmark trial did not start.",
    options.strategy,
  );
  const errors: string[] = [];
  const previousStrategy = process.env.AGENTMELD_CONTEXT_STRATEGY;
  let finalReport: BenchmarkTrialReport | null = null;
  let reportWriteError: unknown;

  try {
    if (options.strategy) process.env.AGENTMELD_CONTEXT_STRATEGY = options.strategy;
    environmentManager.activate(environment);
    activated = true;
    faultInjector.start();
    traceCollector.start();
    collectorStarted = true;
    userSimulator.start();
    simulatorStarted = true;

    conversation = await conversationDriver.startCase(benchmarkCase);
    waitResult = await runWaiter.waitForEnd(conversation.conductorRunId, {
      timeoutMs: Math.min(benchmarkCase.limits.maxDurationMs, options.maxDurationMs ?? Number.POSITIVE_INFINITY),
      signal: options.signal,
      shouldIgnoreRunEndEvent: (eventIndex) => faultInjector.shouldDropRunEndEvent(
        conversation!.conductorRunId,
        eventIndex,
      ),
    });
    if (waitResult.error) errors.push(waitResult.error);

    archive = traceCollector.collect(conversation.conversationId, conversation.conductorRunId);
    if (archive.contextTrace && !waitResult.timedOut) {
      const hiddenValidation = await verifierExecutor.run(
        benchmarkCase,
        conversation.workspacePath,
        conversation.mutationBaselines,
      );
      const collectedValidation = await collectRuntimeValidation(benchmarkCase, archive.contextTrace, {
        reportDir: environment.reportDir,
        injectedFaults: faultInjector.getRecords(),
        ownerSession: environmentManager.ownerSession(),
      });
      runtimeValidation = { ...collectedValidation, ...hiddenValidation };
      result = evaluateBenchmarkTrace(benchmarkCase, archive.contextTrace, {
        startedAt,
        finishedAt: Date.now(),
        strategy: options.strategy,
        runtimeValidation,
      });
      const judgeMode = options.judgeMode ?? "off";
      if (benchmarkCase.judge?.enabled && judgeMode !== "off") {
        const packet = buildJudgePacket(benchmarkCase, archive.contextTrace, result, runtimeValidation);
        judge = await runJudgeEnsemble(benchmarkCase, packet, {
          mode: judgeMode,
          reportDir: environment.reportDir,
          model: options.judgeModel,
          importPath: options.judgeImportPath,
        }, options.judgeRepeat ?? 1);
        result = {
          ...result,
          judge,
          verdict: composeVerdict(result, judge, benchmarkCase.judge.requiredForPass ?? false),
        };
      } else {
        result = {
          ...result,
          judge,
          verdict: composeVerdict(result, judge, false),
        };
      }
      if (waitResult.status !== "complete") {
        result = {
          ...result,
          status: "error",
          error: waitResult.error ?? `Conductor run ended with status ${waitResult.status}.`,
        };
      }
      const budgetError = evaluateTrialBudget(benchmarkCase, result, options.maxCostUsd);
      if (budgetError) {
        result = { ...result, status: "budget_exceeded", error: budgetError };
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
    try { faultInjector.stop(); } catch (error) {
      errors.push(`Fault injector cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
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
    if (previousStrategy === undefined) delete process.env.AGENTMELD_CONTEXT_STRATEGY;
    else process.env.AGENTMELD_CONTEXT_STRATEGY = previousStrategy;

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
      runtimeValidation,
      judge,
      injectedFaults: faultInjector.getRecords(),
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

function evaluateTrialBudget(
  benchmarkCase: AgentBenchmarkCase,
  result: E2ERunResult,
  maxCostUsd?: number,
): string | null {
  if (benchmarkCase.limits.maxModelCalls != null && result.metrics.modelRunCount > benchmarkCase.limits.maxModelCalls) {
    return `Model call budget exceeded: ${result.metrics.modelRunCount}/${benchmarkCase.limits.maxModelCalls}.`;
  }
  if (benchmarkCase.limits.maxToolCalls != null && result.metrics.toolCallCount > benchmarkCase.limits.maxToolCalls) {
    return `Tool call budget exceeded: ${result.metrics.toolCallCount}/${benchmarkCase.limits.maxToolCalls}.`;
  }
  if (benchmarkCase.limits.maxInputTokens != null && result.metrics.inputTokens > benchmarkCase.limits.maxInputTokens) {
    return `Input token budget exceeded: ${result.metrics.inputTokens}/${benchmarkCase.limits.maxInputTokens}.`;
  }
  const estimatedCost = result.judge?.result?.estimatedCostUsd ?? 0;
  if (maxCostUsd != null && estimatedCost > maxCostUsd) return `Judge cost budget exceeded: $${estimatedCost.toFixed(4)}/$${maxCostUsd.toFixed(4)}.`;
  return null;
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
  runtimeValidation: import("@/server/context-metrics/benchmark-types").BenchmarkRuntimeValidation | null;
  judge: JudgeExecution | null;
  injectedFaults: import("@/server/context-metrics/benchmark-types").BenchmarkFaultRecord[];
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
    runtimeValidation: input.runtimeValidation,
    judge: input.judge,
    verdict: composeVerdict(input.result, input.judge, input.benchmarkCase.judge?.requiredForPass ?? false),
    injectedFaults: input.injectedFaults,
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
