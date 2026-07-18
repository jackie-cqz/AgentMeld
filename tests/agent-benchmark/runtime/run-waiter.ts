import { abortRun } from "@/server/agent-runner";
import { eventBus, type EventBus } from "@/server/event-bus";
import { getRun } from "@/server/repositories";
import type { AgentRunStatus } from "@/shared/types";

export interface RunWaitResult {
  runId: string;
  status: AgentRunStatus | "missing";
  timedOut: boolean;
  abortRequested: boolean;
  startedAt: number;
  finishedAt: number;
  error?: string;
}

export interface RunWaitOptions {
  timeoutMs: number;
  pollIntervalMs?: number;
  abortGraceMs?: number;
  signal?: AbortSignal;
  shouldIgnoreRunEndEvent?: (eventIndex: number) => boolean;
}

interface RunWaiterDependencies {
  bus: EventBus;
  getRun: typeof getRun;
  abortRun: typeof abortRun;
}

const defaultDependencies: RunWaiterDependencies = {
  bus: eventBus,
  getRun,
  abortRun,
};

export class RunWaiter {
  constructor(private readonly dependencies: RunWaiterDependencies = defaultDependencies) {}

  waitForEnd(runId: string, options: RunWaitOptions): Promise<RunWaitResult> {
    const startedAt = Date.now();
    const pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 250);
    const abortGraceMs = Math.max(0, options.abortGraceMs ?? 2_000);

    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe: () => void = () => {};
      const timers: {
        interval?: ReturnType<typeof setInterval>;
        timeout?: ReturnType<typeof setTimeout>;
        abortGrace?: ReturnType<typeof setTimeout>;
      } = {};
      let deadlineExceeded = false;
      let timeoutAbortRequested = false;
      let runEndEventIndex = 0;

      const finish = (result: Omit<RunWaitResult, "runId" | "startedAt" | "finishedAt">) => {
        if (settled) return;
        settled = true;
        if (timers.interval) clearInterval(timers.interval);
        if (timers.timeout) clearTimeout(timers.timeout);
        if (timers.abortGrace) clearTimeout(timers.abortGrace);
        unsubscribe();
        options.signal?.removeEventListener("abort", onAbort);
        resolve({ runId, startedAt, finishedAt: Date.now(), ...result });
      };

      const inspect = () => {
        const run = this.dependencies.getRun(runId);
        if (run && isTerminal(run.status)) {
          finish({
            status: run.status,
            timedOut: deadlineExceeded,
            abortRequested: timeoutAbortRequested,
            error: deadlineExceeded
              ? `Run exceeded benchmark timeout of ${options.timeoutMs}ms.${run.error ? ` ${run.error}` : ""}`
              : run.error ?? undefined,
          });
        }
      };

      const onAbort = () => {
        const abortRequested = this.dependencies.abortRun(runId);
        const run = this.dependencies.getRun(runId);
        finish({
          status: run?.status ?? "missing",
          timedOut: false,
          abortRequested,
          error: "Benchmark wait was aborted.",
        });
      };

      unsubscribe = this.dependencies.bus.subscribe(({ event }) => {
        if (event.type === "run.end" && event.runId === runId) {
          runEndEventIndex += 1;
          if (options.shouldIgnoreRunEndEvent?.(runEndEventIndex)) return;
          // run.end is a wake-up signal. The persisted run row is authoritative
          // because some Conductor error paths publish before AgentRunner commits.
          inspect();
        }
      });
      if (settled) unsubscribe();

      timers.interval = setInterval(inspect, pollIntervalMs);
      timers.timeout = setTimeout(() => {
        deadlineExceeded = true;
        timeoutAbortRequested = this.dependencies.abortRun(runId);
        inspect();
        if (settled) return;
        timers.abortGrace = setTimeout(() => {
          const run = this.dependencies.getRun(runId);
          finish({
            status: run?.status ?? "missing",
            timedOut: true,
            abortRequested: timeoutAbortRequested,
            error: `Run exceeded benchmark timeout of ${options.timeoutMs}ms and did not settle within ${abortGraceMs}ms after abort.`,
          });
        }, abortGraceMs);
      }, options.timeoutMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      inspect();
    });
  }
}

function isTerminal(status: AgentRunStatus): boolean {
  return status === "complete" || status === "failed" || status === "aborted";
}
