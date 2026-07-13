import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgentBenchmarkCase } from "@/server/context-metrics/benchmark-types";
import { registerPendingQuestion } from "@/server/pending-questions";

import { runBenchmarkCase } from "./benchmark-runner";
import { ConversationDriver, type BenchmarkConversationStart } from "./conversation-driver";
import { RunWaiter, type RunWaitResult } from "./run-waiter";
import { TraceCollector, type BenchmarkTraceArchive } from "./trace-collector";

let outputDir = "";

beforeAll(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-benchmark-runner-"));
});

afterAll(() => {
  fs.rmSync(outputDir, { recursive: true, force: true });
});

describe("runBenchmarkCase", () => {
  it("writes a report even when the conversation driver throws", async () => {
    const report = await runBenchmarkCase(createCase(), {
      outputDir,
      dependencies: { conversationDriver: new FailingConversationDriver() },
    });

    expect(report.result.status).toBe("error");
    expect(report.errors.join(" ")).toContain("driver failed");
    expect(fs.existsSync(report.reportPath)).toBe(true);
    expect(fs.existsSync(report.tracePath)).toBe(true);
  });

  it("links conversation, run, attempts, and isolated paths in the report", async () => {
    const report = await runBenchmarkCase(createCase(), {
      outputDir,
      trialIndex: 2,
      dependencies: {
        conversationDriver: new StubConversationDriver(),
        runWaiter: new CompletedRunWaiter(),
        traceCollector: new StubTraceCollector(),
      },
    });

    expect(report).toMatchObject({
      conversationId: "conv_benchmark",
      conductorRunId: "run_benchmark",
      taskAttemptIds: ["attempt_pm", "attempt_frontend"],
      trialIndex: 2,
      timedOut: false,
    });
    expect(report.workspacePath).toContain("workspace");
    expect(report.dataDir).toContain(report.environmentId);
    const persisted = JSON.parse(fs.readFileSync(report.reportPath, "utf-8")) as typeof report;
    expect(persisted.conductorRunId).toBe("run_benchmark");
  });

  it("still persists the report when trace persistence fails", async () => {
    const report = await runBenchmarkCase(createCase(), {
      outputDir,
      trialIndex: 3,
      dependencies: {
        conversationDriver: new StubConversationDriver(),
        runWaiter: new TimedOutRunWaiter(),
        traceCollector: new FailingTraceWriter(),
      },
    });

    expect(report.timedOut).toBe(true);
    expect(report.errors.join(" ")).toContain("Trace persistence failed");
    expect(fs.existsSync(report.reportPath)).toBe(true);
  });

  it("starts the user simulator before the driver asks a question", async () => {
    const driver = new AskingConversationDriver();
    const benchmarkCase = createCase();
    benchmarkCase.runtime = {
      userScript: {
        questions: [{ match: "交付范围", answers: { "0": "标准版" } }],
      },
    };

    const report = await runBenchmarkCase(benchmarkCase, {
      outputDir,
      trialIndex: 4,
      dependencies: {
        conversationDriver: driver,
        runWaiter: new CompletedRunWaiter(),
        traceCollector: new StubTraceCollector(),
      },
    });

    expect(driver.answers).toEqual({ "0": "标准版" });
    expect(report.userActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ask_user", decision: "answer", success: true }),
    ]));
    expect(fs.existsSync(report.reportPath)).toBe(true);
  });
});

class FailingConversationDriver extends ConversationDriver {
  override async startCase(): Promise<BenchmarkConversationStart> {
    throw new Error("driver failed before model invocation");
  }
}

class StubConversationDriver extends ConversationDriver {
  override async startCase(): Promise<BenchmarkConversationStart> {
    return {
      conversationId: "conv_benchmark",
      conductorRunId: "run_benchmark",
      triggerMessageId: "msg_benchmark",
      workspacePath: "C:\\isolated\\workspace",
      agentIds: ["ag_mock_conductor", "ag_pm", "ag_mock_builder"],
      roleAgentIds: {
        conductor: "ag_mock_conductor",
        pm: "ag_pm",
        frontend: "ag_mock_builder",
      },
    };
  }
}

class AskingConversationDriver extends StubConversationDriver {
  answers: Record<string, string> | null = null;

  override async startCase(): Promise<BenchmarkConversationStart> {
    this.answers = await registerPendingQuestion("conv_benchmark", "ag_mock_conductor", "run_benchmark", [{
      header: "交付范围",
      question: "请选择交付范围",
      options: [{ label: "标准版" }, { label: "精简版" }],
    }]);
    return super.startCase();
  }
}

class CompletedRunWaiter extends RunWaiter {
  override async waitForEnd(runId: string): Promise<RunWaitResult> {
    const now = Date.now();
    return {
      runId,
      status: "complete",
      timedOut: false,
      abortRequested: false,
      startedAt: now,
      finishedAt: now,
    };
  }
}

class StubTraceCollector extends TraceCollector {
  override collect(conversationId: string | null, conductorRunId: string | null): BenchmarkTraceArchive {
    return {
      schemaVersion: 1,
      collectedAt: Date.now(),
      conversationId,
      conductorRunId,
      runs: [],
      taskAttemptIds: ["attempt_pm", "attempt_frontend"],
      events: [],
      traceError: "Synthetic test trace has no graded tasks.",
    };
  }
}

class FailingTraceWriter extends StubTraceCollector {
  override write(): string {
    throw new Error("trace disk unavailable");
  }
}

class TimedOutRunWaiter extends RunWaiter {
  override async waitForEnd(runId: string): Promise<RunWaitResult> {
    const now = Date.now();
    return {
      runId,
      status: "aborted",
      timedOut: true,
      abortRequested: true,
      startedAt: now,
      finishedAt: now,
      error: "synthetic timeout",
    };
  }
}

function createCase(): AgentBenchmarkCase {
  return {
    schemaVersion: 1,
    id: "runner-case",
    title: "Runner Case",
    description: "Exercises report guarantees.",
    category: "collaboration",
    prompt: "Build an app.",
    expectedRoles: ["pm", "frontend"],
    assertions: [{ id: "pm-ran", type: "role_executed", role: "pm", required: true }],
    limits: { maxDurationMs: 1000 },
    tags: ["smoke"],
  };
}
