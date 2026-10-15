import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getDatabase } from "@/db/client";
import { PiRuntimeError } from "./process";

interface LeaseRow { token: string; owner_pid: number; child_pid: number | null; status: string }
export interface PiWorkspaceLease { attachChild: (pid: number) => void; release: () => void; poison: () => void }

/** SQLite receipts survive hot reloads and exclude writers in other control processes. */
export async function acquirePiWorkspace(workspace: string, signal: AbortSignal): Promise<PiWorkspaceLease> {
  const physical = fs.realpathSync(workspace);
  const key = process.platform === "win32" ? path.normalize(physical).toLowerCase() : physical;
  const token = randomUUID();
  const db = getDatabase();
  for (;;) {
    signal.throwIfAborted();
    const receipt = db.prepare("INSERT OR IGNORE INTO harness_workspace_leases (workspace_key,token,owner_pid,status,created_at) VALUES (?,?,?,?,?)")
      .run(key, token, process.pid, "held", Date.now()) as { changes?: number | bigint };
    if (Number(receipt.changes) === 1) break;
    const current = db.prepare("SELECT token,owner_pid,child_pid,status FROM harness_workspace_leases WHERE workspace_key=?").get(key) as LeaseRow | undefined;
    if (current && !isProcessAlive(current.owner_pid) && (current.child_pid === null || !isProcessAlive(current.child_pid))) {
      db.prepare("DELETE FROM harness_workspace_leases WHERE workspace_key=? AND token=?").run(key, current.token);
      continue;
    }
    if (current?.status === "poisoned") throw new PiRuntimeError("A previous writer could not be stopped. Inspect the Pi execution before clearing its workspace lease.", "cleanup_failed");
    await delay(100, undefined, { signal });
  }
  let released = false;
  return {
    attachChild(pid) {
      const result = db.prepare("UPDATE harness_workspace_leases SET child_pid=? WHERE workspace_key=? AND token=?").run(pid, key, token) as { changes?: number | bigint };
      if (Number(result.changes) !== 1) throw new PiRuntimeError("Pi lost workspace ownership before starting.", "workspace_ownership");
    },
    release() {
      if (released) return;
      released = true;
      db.prepare("DELETE FROM harness_workspace_leases WHERE workspace_key=? AND token=? AND status='held'").run(key, token);
    },
    poison() { db.prepare("UPDATE harness_workspace_leases SET status='poisoned' WHERE workspace_key=? AND token=?").run(key, token); },
  };
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH"); }
}
