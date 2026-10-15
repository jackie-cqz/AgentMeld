export type ToolCallState = "running" | "failed" | "complete";
type DisplayCall = { toolName: string; result?: { isError?: boolean; result: unknown } };
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function payload(raw: unknown) { return record(raw) && "value" in raw ? raw.value : raw; }

export function toolCallState(toolName: string, result: { isError?: boolean; result: unknown } | undefined, messageDone: boolean): ToolCallState {
  if (!result) return messageDone ? "failed" : "running";
  const raw = result.result;
  const value = payload(raw);
  if (result.isError || (record(raw) && raw.ok === false)) return "failed";
  if (record(value)) {
    if (value.passed === false) return "failed";
    if (toolName.startsWith("job_")) {
      if (value.status === "running") return "running";
      if (["failed", "cancelled", "timed_out"].includes(String(value.status)) || value.timedOut === true || ("exitCode" in value && value.exitCode !== 0)) return "failed";
    }
    if (toolName === "bash" && (value.timedOut === true || ("exitCode" in value && value.exitCode !== 0))) return "failed";
  }
  return "complete";
}

export function toolCallStates(calls: DisplayCall[], messageDone: boolean): ToolCallState[] {
  const jobs = new Map<string, NonNullable<DisplayCall["result"]>>();
  for (const call of calls) {
    const value = payload(call.result?.result);
    if (call.toolName.startsWith("job_") && call.result && !call.result.isError && record(value) && typeof value.jobId === "string" && ["running", "completed", "failed", "cancelled", "timed_out"].includes(String(value.status))) jobs.set(value.jobId, call.result);
  }
  return calls.map(call => {
    const value = payload(call.result?.result);
    const latest = call.toolName.startsWith("job_") && record(value) && typeof value.jobId === "string" && !call.result?.isError ? jobs.get(value.jobId) : undefined;
    return toolCallState(call.toolName, latest ?? call.result, messageDone);
  });
}

export function summarizeToolCalls(calls: DisplayCall[], messageDone: boolean) {
  const counts = { complete: 0, failed: 0, running: 0 };
  for (const state of toolCallStates(calls, messageDone)) counts[state]++;
  return { ...counts, label: [counts.complete && `成功 ${counts.complete}`, counts.failed && `失败 ${counts.failed}`, counts.running && `运行中 ${counts.running}`].filter(Boolean).join(" · "),
    status: counts.failed ? "error" as const : counts.running ? "pending" as const : "complete" as const };
}
