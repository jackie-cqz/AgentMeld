import type { BenchmarkFaultRecord, BenchmarkFaultSpec } from "@/server/context-metrics/benchmark-types";
import { setToolArgumentFaultInterceptorForTests } from "@/server/adapters/custom-agent-adapter";
import { abortRun } from "@/server/agent-runner";
import { eventBus, type EventBus } from "@/server/event-bus";
import { toolRegistry } from "@/server/tools/registry";
import type { ToolContext, ToolResult } from "@/server/tools/types";

interface FaultInjectorDependencies {
  bus: EventBus;
  abortRun: typeof abortRun;
}

const defaultDependencies: FaultInjectorDependencies = { bus: eventBus, abortRun };

export class FaultInjector {
  private counts = new Map<string, number>();
  private records: BenchmarkFaultRecord[] = [];
  private started = false;
  private previousFlag: string | undefined;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly faults: BenchmarkFaultSpec[] = [],
    private readonly dependencies: FaultInjectorDependencies = defaultDependencies,
  ) {}

  start(): void {
    if (this.started) throw new Error("FaultInjector is already started.");
    this.started = true;
    if (!this.faults.length) return;
    this.previousFlag = process.env.AGENTMELD_BENCH_FAULT_INJECTION;
    process.env.AGENTMELD_BENCH_FAULT_INJECTION = "1";
    setToolArgumentFaultInterceptorForTests((input) => this.injectToolArguments(input));
    toolRegistry.setExecutionInterceptorForTests((name, args, context) => this.intercept(name, args, context));
    if (this.faults.some((fault) => fault.type === "child_run_abort")) {
      this.unsubscribe = this.dependencies.bus.subscribe(({ event }) => {
        if (event.type !== "run.start" || !event.parentRunId) return;
        this.abortChildRun(event.runId);
      });
    }
  }

  stop(): void {
    if (!this.started) return;
    if (this.faults.length) {
      setToolArgumentFaultInterceptorForTests(null);
      toolRegistry.setExecutionInterceptorForTests(null);
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.previousFlag === undefined) delete process.env.AGENTMELD_BENCH_FAULT_INJECTION;
    else process.env.AGENTMELD_BENCH_FAULT_INJECTION = this.previousFlag;
    this.started = false;
  }

  getRecords(): BenchmarkFaultRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  shouldDropRunEndEvent(runId: string, eventIndex: number): boolean {
    for (const fault of this.faults) {
      if (fault.type !== "sse_disconnect") continue;
      if (eventIndex !== (fault.occurrence ?? 1)) continue;
      if (this.records.some((record) => record.id === fault.id)) continue;
      this.records.push(this.createRecord(fault, {
        runId,
        taskId: null,
        occurrence: eventIndex,
        detail: fault.message ?? defaultMessage(fault),
      }));
      return true;
    }
    return false;
  }

  injectToolArguments(input: { runId: string; toolName: string; rawArguments: string }): string | null {
    for (const fault of this.faults) {
      if (fault.type !== "tool_arguments_json" || fault.toolName !== input.toolName) continue;
      const count = (this.counts.get(fault.id) ?? 0) + 1;
      this.counts.set(fault.id, count);
      if (count !== (fault.occurrence ?? 1)) continue;
      const detail = fault.message ?? defaultMessage(fault);
      this.records.push({
        id: fault.id,
        type: fault.type,
        toolName: fault.toolName,
        occurrence: count,
        runId: input.runId,
        taskId: null,
        injectedAt: Date.now(),
        detail,
      });
      return `${input.rawArguments.slice(0, Math.max(1, input.rawArguments.length - 1))}`;
    }
    return null;
  }

  private intercept(name: string, args: unknown, context: ToolContext): ToolResult | null {
    for (const fault of this.faults) {
      if (fault.type === "task_report_fake_deployment" && fault.toolName === name) {
        const count = (this.counts.get(fault.id) ?? 0) + 1;
        this.counts.set(fault.id, count);
        if (count !== (fault.occurrence ?? 1)) continue;
        const detail = fault.message ?? defaultMessage(fault);
        if (args && typeof args === "object") {
          const mutable = args as Record<string, unknown>;
          mutable.summary =
            `${typeof mutable.summary === "string" ? mutable.summary : ""}\n` +
            "Deployment completed: /deployments/dep_benchmark_fake (benchmark injected claim).";
        }
        this.records.push({
          id: fault.id,
          type: fault.type,
          toolName: fault.toolName,
          occurrence: count,
          runId: context.runId,
          taskId: context.taskExecution?.taskId ?? null,
          injectedAt: Date.now(),
          detail,
        });
        return null;
      }
      if (
        fault.type === "sse_disconnect" ||
        fault.type === "child_run_abort" ||
        fault.type === "tool_arguments_json"
      ) continue;
      if (fault.toolName !== name || !matchesCommand(fault, args)) continue;
      const count = (this.counts.get(fault.id) ?? 0) + 1;
      this.counts.set(fault.id, count);
      if (count !== (fault.occurrence ?? 1)) continue;
      const detail = fault.message ?? defaultMessage(fault);
      this.records.push({
        id: fault.id,
        type: fault.type,
        toolName: fault.toolName,
        occurrence: count,
        runId: context.runId,
        taskId: context.taskExecution?.taskId ?? null,
        injectedAt: Date.now(),
        detail,
      });
      if (fault.type === "command_nonzero") {
        return { ok: false, error: `[benchmark_fault] ${detail}` };
      }
      if (fault.type === "deployment_missing") {
        return {
          ok: false,
          error: `[benchmark_fault] ${detail}`,
          code: "BENCHMARK_DEPLOYMENT_PATH_MISSING",
          category: "tool_error",
        };
      }
      return { ok: false, error: `[benchmark_fault] ${detail}` };
    }
    return null;
  }

  private abortChildRun(runId: string): void {
    for (const fault of this.faults) {
      if (fault.type !== "child_run_abort") continue;
      const count = (this.counts.get(fault.id) ?? 0) + 1;
      this.counts.set(fault.id, count);
      if (count !== (fault.occurrence ?? 1)) continue;
      const aborted = this.dependencies.abortRun(runId);
      const detail = fault.message ?? defaultMessage(fault);
      this.records.push(this.createRecord(fault, {
        runId,
        taskId: null,
        occurrence: count,
        detail: `${detail} abortRequested=${aborted}`,
      }));
    }
  }

  private createRecord(
    fault: BenchmarkFaultSpec,
    input: Pick<BenchmarkFaultRecord, "runId" | "taskId" | "occurrence" | "detail">,
  ): BenchmarkFaultRecord {
    return {
      id: fault.id,
      type: fault.type,
      toolName: fault.toolName,
      occurrence: input.occurrence,
      runId: input.runId,
      taskId: input.taskId,
      injectedAt: Date.now(),
      detail: input.detail,
    };
  }
}

function matchesCommand(fault: BenchmarkFaultSpec, args: unknown): boolean {
  if (!fault.commandPattern) return true;
  const command = args && typeof args === "object" && "command" in args ? String((args as { command?: unknown }).command ?? "") : "";
  return command.toLowerCase().includes(fault.commandPattern.toLowerCase());
}

function defaultMessage(fault: BenchmarkFaultSpec): string {
  if (fault.type === "tool_arguments_json") return `Injected malformed JSON arguments for ${fault.toolName}.`;
  if (fault.type === "command_nonzero") return `Injected non-zero command result for ${fault.toolName}.`;
  if (fault.type === "deployment_missing") return `Injected missing deployment path for ${fault.toolName}.`;
  if (fault.type === "task_report_fake_deployment") return "Injected an unsupported deployment path into the task report.";
  if (fault.type === "sse_disconnect") return "Injected a temporary run.end event disconnect; database polling must recover.";
  if (fault.type === "child_run_abort") return "Injected an abort into a child Agent run.";
  return `Injected tool failure for ${fault.toolName}.`;
}
