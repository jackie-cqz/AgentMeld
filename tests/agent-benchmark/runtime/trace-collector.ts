import fs from "node:fs";
import path from "node:path";

import { getDatabase } from "@/db/client";
import { getContextTraceByRun } from "@/server/context-trace/context-trace-service";
import type { ContextTraceRunResponse } from "@/server/context-trace/context-trace-types";
import { computeRunMetrics } from "@/server/context-metrics/context-metrics-service";
import type { ContextQualityReport } from "@/server/context-metrics/context-metrics-types";
import { eventBus, type EventBus, type EventBusEntry } from "@/server/event-bus";
import { listRuns } from "@/server/repositories";
import type { AgentRun } from "@/shared/types";

export interface BenchmarkTraceArchive {
  schemaVersion: 1;
  collectedAt: number;
  conversationId: string | null;
  conductorRunId: string | null;
  runs: AgentRun[];
  taskAttemptIds: string[];
  events: EventBusEntry[];
  contextTrace?: ContextTraceRunResponse;
  contextMetrics?: ContextQualityReport;
  traceError?: string;
}

export class TraceCollector {
  private entries: EventBusEntry[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly bus: EventBus = eventBus) {}

  start(): void {
    if (this.unsubscribe) throw new Error("TraceCollector is already running.");
    this.unsubscribe = this.bus.subscribe((entry) => this.entries.push(entry));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  collect(conversationId: string | null, conductorRunId: string | null): BenchmarkTraceArchive {
    const events = conversationId
      ? this.entries.filter((entry) => entry.event.conversationId === conversationId)
      : [...this.entries];
    const runs = conversationId ? listRuns(conversationId) : [];
    const taskAttemptIds = conductorRunId ? readTaskAttemptIds(conductorRunId) : [];
    let contextTrace: ContextTraceRunResponse | undefined;
    let contextMetrics: ContextQualityReport | undefined;
    let traceError: string | undefined;

    if (conductorRunId) {
      const result = getContextTraceByRun(conductorRunId);
      if ("error" in result) traceError = result.error;
      else contextTrace = result;
      const metricResult = computeRunMetrics(conductorRunId);
      if (!("error" in metricResult)) contextMetrics = metricResult;
    }

    return {
      schemaVersion: 1,
      collectedAt: Date.now(),
      conversationId,
      conductorRunId,
      runs,
      taskAttemptIds,
      events,
      contextTrace,
      contextMetrics,
      traceError,
    };
  }

  write(filePath: string, archive: BenchmarkTraceArchive): string {
    const absolutePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, JSON.stringify(archive, null, 2), "utf-8");
    return absolutePath;
  }
}

function readTaskAttemptIds(conductorRunId: string): string[] {
  const rows = getDatabase()
    .prepare("SELECT id FROM task_attempts WHERE conductor_run_id = ? ORDER BY task_id, attempt")
    .all(conductorRunId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}
