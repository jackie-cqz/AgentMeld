import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { captureEvidence } from "@/server/evidence/evidence-collector";
import { recordCommandEvidence } from "@/server/dispatch-tool-evidence";
import { toolProcessEnv } from "@/server/tools/workspace-access";
import type { ToolContext } from "@/server/tools/types";

type Status = "running" | "completed" | "failed" | "cancelled" | "timed_out";
interface Job {
  id: string; conversationId: string; agentId: string; runId: string; workspacePath: string;
  command: string; cwd: string; status: Status; output: string; logTruncated: boolean;
  exitCode: number | null; startedAt: number; finishedAt: number | null;
  done: Promise<void>; cancel: () => void;
}
declare global {
  var __agentMeldCommandJobs: Map<string, Job> | undefined;
  var __agentMeldCommandJobsExitHook: boolean | undefined;
}
const jobs = globalThis.__agentMeldCommandJobs ??= new Map<string, Job>();
if (!globalThis.__agentMeldCommandJobsExitHook) {
  globalThis.__agentMeldCommandJobsExitHook = true;
  process.once("exit", () => { for (const job of jobs.values()) if (job.status === "running") job.cancel(); });
}

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
    killer.on("close", code => { if (code !== 0) child.kill(); });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

export function startCommandJob(cmd: string, args: string[], cwd: string, command: string, ctx: ToolContext, timeoutMs: number) {
  if (ctx.abortSignal.aborted) throw new Error("Run cancelled before command start.");
  const running = [...jobs.values()].filter(job => job.status === "running");
  if (running.length >= 8 || running.filter(job => job.runId === ctx.runId).length >= 2) throw new Error("Background job limit reached; wait for or cancel an existing job.");
  for (const job of jobs.values()) if (jobs.size >= 64 && job.status !== "running") jobs.delete(job.id);
  let resolveDone!: () => void;
  const job: Job = { id: `job_${randomUUID()}`, conversationId: ctx.conversationId, agentId: ctx.agentId, runId: ctx.runId, workspacePath: ctx.workspacePath,
    command, cwd, status: "running", output: "", logTruncated: false, exitCode: null, startedAt: Date.now(), finishedAt: null,
    done: new Promise(resolve => { resolveDone = resolve; }), cancel: () => {} };
  const child = spawn(cmd, args, { cwd, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: toolProcessEnv() });
  jobs.set(job.id, job);
  let finishing = false; let forced: Status | null = null;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const append = (text: string) => { if (job.output.length + text.length > 200000) job.logTruncated = true; job.output = (job.output + text).slice(0, 200000); };
  const finish = async (code: number | null) => {
    if (finishing) return; finishing = true;
    clearTimeout(timer); if (fallback) clearTimeout(fallback); ctx.abortSignal.removeEventListener("abort", onAbort);
    const status = forced ?? (code === 0 ? "completed" : "failed");
    job.exitCode = forced ? null : code;
    const value = { jobId: job.id, command, cwd, status, exitCode: job.exitCode, timedOut: status === "timed_out", output: job.output, truncated: job.logTruncated };
    if (ctx.parentRunId) recordCommandEvidence(ctx.runId, { command, cwd, exitCode: job.exitCode, timedOut: status === "timed_out", isError: job.exitCode !== 0 });
    try { await captureEvidence({ toolName: "job_completion", args: { command }, result: { ok: true, value }, context: ctx, durationMs: Date.now() - job.startedAt, callId: job.id }); }
    catch (error) { console.error("[command-jobs] evidence capture failed:", error); }
    finally { job.status = status; job.finishedAt = Date.now(); resolveDone(); }
  };
  const terminate = (status: Status) => {
    if (finishing || forced) return; forced = status; killTree(child);
    fallback = setTimeout(() => { append("\nProcess cancellation could not be confirmed. Check the server's process list before retrying.\n"); forced = "failed"; child.kill(); void finish(null); }, 3000);
  };
  const onAbort = () => terminate("cancelled");
  const timer = setTimeout(() => terminate("timed_out"), timeoutMs);
  job.cancel = onAbort;
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder("utf8");
    stream?.on("data", chunk => append(decoder.write(chunk)));
    stream?.on("end", () => append(decoder.end()));
  }
  child.once("error", error => { append(`Process error: ${error.message}`); void finish(null); });
  child.once("close", code => void finish(code));
  ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
  if (ctx.abortSignal.aborted) onAbort();
  return jobView(job, 0);
}

function ownedJob(id: string, ctx: ToolContext) {
  const job = jobs.get(id);
  if (!job || job.conversationId !== ctx.conversationId || job.agentId !== ctx.agentId || job.runId !== ctx.runId || job.workspacePath !== ctx.workspacePath) throw new Error("Job not found in this run. Jobs are process-local and cannot be recovered after server restart.");
  return job;
}
function jobView(job: Job, offset: number) {
  const output = job.output.slice(offset, offset + 10000);
  return { jobId: job.id, command: job.command, cwd: job.cwd, status: job.status, exitCode: job.exitCode, startedAt: job.startedAt, finishedAt: job.finishedAt,
    output, nextOffset: Math.min(job.output.length, offset + output.length), hasMoreOutput: offset + output.length < job.output.length, logTruncated: job.logTruncated,
    timedOut: job.status === "timed_out", ...(job.status === "running" ? { hint: "Still running. Use job_wait; starting a job is not proof of success." } : {}) };
}
export async function controlCommandJob(action: "read" | "wait" | "cancel", id: string, offset: number, waitMs: number, ctx: ToolContext) {
  const job = ownedJob(id, ctx);
  if (action === "cancel") job.cancel();
  if (action !== "read" && job.status === "running") {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([job.done, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  return jobView(job, offset);
}
export function hasRunningJobs(runId: string) { return [...jobs.values()].some(job => job.runId === runId && job.status === "running"); }
export async function cancelJobsForRun(runId: string) { const owned = [...jobs.values()].filter(job => job.runId === runId && job.status === "running"); for (const job of owned) job.cancel(); await Promise.all(owned.map(job => job.done)); }
export async function clearCommandJobsForTests() { for (const job of jobs.values()) job.cancel(); await Promise.all([...jobs.values()].map(job => job.done)); jobs.clear(); }
