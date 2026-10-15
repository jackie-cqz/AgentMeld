import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { encodePiCommand, PiEventQueue, PiJsonLines, type PiRecord } from "./protocol";

export class PiRuntimeError extends Error {
  constructor(message: string, readonly category: string) { super(message); }
}

interface PendingRequest {
  resolve: (value: PiRecord) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PiProcessOptions {
  cliPath: string;
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

/** Owns exactly one Pi subprocess; successful close means confirmed process exit. */
export class PiProcess {
  readonly events = new PiEventQueue();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requests = new Map<string, PendingRequest>();
  private readonly exited: Promise<void>;
  private exitObserved = false;
  private closing: Promise<void> | null = null;
  private stderr = "";
  private readonly externalTools = new Set<string>();

  constructor(private readonly options: PiProcessOptions) {
    this.child = spawn(process.execPath, [options.cliPath, "--mode", "rpc", ...options.args], {
      cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = new PiJsonLines();
    this.exited = new Promise<void>((resolve) => {
      this.child.once("close", (code, signal) => {
        this.exitObserved = true;
        let error: Error | undefined;
        try { lines.finish(); } catch (failure) { error = asError(failure); }
        if (!this.closing) error ??= new PiRuntimeError(`Pi exited unexpectedly (${code ?? signal ?? "unknown"}).`, "process_exit");
        this.rejectRequests(error ?? new PiRuntimeError("Pi process closed.", "process_exit"));
        this.events.end(error);
        resolve();
      });
    });
    this.child.on("error", (error) => this.fail(new PiRuntimeError(`Cannot start Pi: ${error.message}`, "startup")));
    this.child.stdin.on("error", (error) => { if (!this.closing) this.fail(error); });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try { for (const record of lines.push(chunk)) this.accept(record); }
      catch (error) { this.fail(new PiRuntimeError(`Invalid Pi protocol: ${asError(error).message}`, "protocol")); }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      // Never persist stderr: provider errors and extension diagnostics may contain credentials.
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8192);
    });
  }

  async request(type: string, params: Record<string, unknown> = {}): Promise<PiRecord> {
    if (this.exitObserved || this.closing) throw new PiRuntimeError("Pi is no longer accepting commands.", "process_exit");
    return this.sendRequest(type, params, this.options.requestTimeoutMs ?? 15000);
  }

  private sendRequest(type: string, params: Record<string, unknown>, timeoutMs: number): Promise<PiRecord> {
    const id = randomUUID();
    return new Promise<PiRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new PiRuntimeError(`Pi ${type} request timed out.`, "timeout"));
      }, timeoutMs);
      this.requests.set(id, { resolve, reject, timer });
      this.child.stdin.write(encodePiCommand({ ...params, type, id }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.requests.delete(id);
          reject(new PiRuntimeError(`Pi ${type} command could not be sent.`, "transport"));
        }
      });
    });
  }

  close(): Promise<void> {
    this.closing ??= this.stop();
    return this.closing;
  }

  get pid(): number | undefined { return this.child.pid; }

  private async stop(): Promise<void> {
    if (this.exitObserved) {
      if (this.externalTools.size) throw new PiRuntimeError("Pi exited during a native command; descendant termination is unconfirmed.", "cleanup_failed");
      return;
    }
    // EOF disposes the runtime, but Pi's abort command first stops active native
    // tools (including detached Bash children) and waits for the turn to settle.
    let abortAcknowledged = false;
    try { await this.sendRequest("abort", {}, 1000); abortAcknowledged = true; } catch { /* Escalate below if Pi cannot acknowledge. */ }
    this.child.stdin.end();
    if (await waitFor(this.exited, this.options.shutdownTimeoutMs ?? 2000)) {
      if (!abortAcknowledged && this.externalTools.size) throw new PiRuntimeError("Native command teardown was not acknowledged; workspace remains locked.", "cleanup_failed");
      return;
    }
    const pid = this.child.pid;
    if (pid !== undefined) {
      if (process.platform === "win32") {
        await new Promise<void>((resolve, reject) => {
          const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", shell: false });
          killer.once("error", reject);
          killer.once("close", () => resolve());
        });
      } else {
        try { process.kill(-pid, "SIGTERM"); } catch (error) { if (!this.exitObserved) throw error; }
        if (!await waitFor(this.exited, 1000)) {
          try { process.kill(-pid, "SIGKILL"); } catch (error) { if (!this.exitObserved) throw error; }
        }
      }
    }
    if (!await waitFor(this.exited, 5000)) throw new PiRuntimeError("Pi termination could not be confirmed; workspace remains locked.", "cleanup_failed");
    if (!abortAcknowledged && this.externalTools.size && process.platform !== "win32") throw new PiRuntimeError("Detached native command teardown could not be confirmed; workspace remains locked.", "cleanup_failed");
  }

  private accept(record: PiRecord): void {
    if (record.type === "tool_execution_start" && ["bash", "grep", "find"].includes(String(record.toolName))) this.externalTools.add(String(record.toolCallId));
    if (record.type === "tool_execution_end") this.externalTools.delete(String(record.toolCallId));
    if (record.type !== "response") { this.events.push(record); return; }
    if (typeof record.id !== "string") throw new PiRuntimeError("Pi response has no correlation ID.", "protocol");
    const pending = this.requests.get(record.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.requests.delete(record.id);
    if (record.success === true) pending.resolve(record);
    else pending.reject(new PiRuntimeError(`Pi ${String(record.command)} command was rejected.`, "protocol"));
  }

  private fail(error: Error): void {
    this.rejectRequests(error);
    this.events.end(error);
    void this.close().catch(() => { /* The invocation owner awaits and records cleanup failure. */ });
  }

  private rejectRequests(error: Error): void {
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error); }
    this.requests.clear();
  }
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

async function waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
