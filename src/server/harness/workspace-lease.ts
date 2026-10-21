import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getDatabase } from "@/db/client";
import { HarnessError } from "./errors";
import type { HarnessWorkspaceLease, LendableWorkspaceLease } from "./types";

/**
 * Platform-owned workspace ownership (#25 P2).
 *
 * Exclusive ownership of a workspace is a platform concept, not an engine one:
 * two runs must never write the same files at once, and uncertain teardown must
 * keep the workspace locked on every engine. This module owns the durable
 * SQLite receipt (`harness_workspace_leases`), the acquire/release/poison
 * lifecycle and the controlled lending used by a peer consultation.
 *
 * A driver receives the resulting lease through
 * `HarnessInvocationInput.workspaceLease`; it never implements acquisition or
 * lending itself. `ownerLabel` is the only engine-specific input and is used
 * solely in failure messages, so Pi keeps its existing wording verbatim.
 */

interface LeaseRow { token: string; owner_pid: number; child_pid: number | null; status: string }

export interface WorkspaceLeaseOptions {
  /**
   * Human-facing owner name used in failure messages (e.g. "Pi"). Required: the
   * platform does not guess which engine's ownership failed.
   */
  ownerLabel: string;
}

/**
 * A platform lease adds the lend operation to the driver-facing contract.
 *
 * Lending is implemented once here and called by the platform's tool bridge
 * around `consult_agent`; a driver receives the object but does not implement
 * the handoff.
 */
export type PlatformWorkspaceLease = LendableWorkspaceLease;

/** True when this ownership object carries the platform lend contract. */
export function isPlatformWorkspaceLease(lease: HarnessWorkspaceLease): lease is LendableWorkspaceLease {
  return typeof (lease as { lend?: unknown }).lend === "function";
}

/** SQLite receipts survive hot reloads and exclude writers in other control processes. */
export async function acquireWorkspaceLease(
  workspace: string,
  signal: AbortSignal,
  options: WorkspaceLeaseOptions,
): Promise<PlatformWorkspaceLease> {
  const owner = options.ownerLabel;
  const physical = fs.realpathSync.native(workspace);
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
      // Parent PID disappearance is not a receipt for detached descendants.
      if (current.child_pid !== null) {
        db.prepare("UPDATE harness_workspace_leases SET status='poisoned' WHERE workspace_key=? AND token=?").run(key, current.token);
        throw new HarnessError(`Previous ${owner} ownership ended without a teardown receipt. Inspect native descendants before clearing the workspace lease.`, "cleanup_failed");
      }
      db.prepare("DELETE FROM harness_workspace_leases WHERE workspace_key=? AND token=?").run(key, current.token);
      continue;
    }
    if (current?.status === "poisoned") throw new HarnessError(`A previous writer could not be stopped. Inspect the ${owner} execution before clearing its workspace lease.`, "cleanup_failed");
    await delay(100, undefined, { signal });
  }
  let released = false;
  let lending = false;
  let childPid: number | null = null;
  const assertHeld = () => {
    const current = db.prepare("SELECT token,status FROM harness_workspace_leases WHERE workspace_key=?").get(key) as LeaseRow | undefined;
    if (released || current?.token !== token || current.status !== "held") throw new HarnessError(`${owner} workspace ownership is unavailable or its teardown is unconfirmed.`, "cleanup_failed");
  };
  const lease: PlatformWorkspaceLease = {
    workspacePath: physical,
    assertActive() {
      assertHeld();
      if (lending) throw new HarnessError(`${owner} is waiting for its peer to return workspace ownership.`, "workspace_ownership");
    },
    attachChild(pid) {
      lease.assertActive();
      const result = db.prepare("UPDATE harness_workspace_leases SET child_pid=? WHERE workspace_key=? AND token=?").run(pid, key, token) as { changes?: number | bigint };
      if (Number(result.changes) !== 1) throw new HarnessError(`${owner} lost workspace ownership before starting.`, "workspace_ownership");
      childPid = pid;
    },
    release() {
      if (released) return;
      if (lending) { lease.poison(); return; }
      released = true;
      db.prepare("DELETE FROM harness_workspace_leases WHERE workspace_key=? AND token=? AND status='held'").run(key, token);
    },
    poison() { db.prepare("UPDATE harness_workspace_leases SET status='poisoned' WHERE workspace_key=? AND token=?").run(key, token); },
    async lend(runPeer) {
      lease.assertActive();
      lending = true;
      let peerReleased = false;
      let peerStarted = false;
      const peer: LendableWorkspaceLease = {
        workspacePath: physical,
        assertActive() {
          assertHeld();
          if (!lending || peerReleased) throw new HarnessError("Peer workspace handoff has ended.", "workspace_ownership");
        },
        attachChild(pid) {
          peer.assertActive();
          db.prepare("UPDATE harness_workspace_leases SET child_pid=? WHERE workspace_key=? AND token=? AND status='held'").run(pid, key, token);
          peerStarted = true;
        },
        release() { peerReleased = true; },
        poison: lease.poison,
        async lend() { throw new HarnessError("Nested workspace consultation is not supported.", "workspace_ownership"); },
      };
      try { return await runPeer(peer); }
      finally {
        // An attached peer must positively confirm teardown before its caller
        // can regain access. Crashes keep its PID and poison the durable lease.
        if (peerStarted && !peerReleased) lease.poison();
        lending = false;
        assertHeld();
        db.prepare("UPDATE harness_workspace_leases SET child_pid=? WHERE workspace_key=? AND token=? AND status='held'").run(childPid, key, token);
      }
    },
  };
  return lease;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH"); }
}
