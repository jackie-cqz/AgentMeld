import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDatabase } from "@/db/client";
import { acquirePiWorkspace } from "./workspace-lease";

let workspace: string;
beforeEach(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lease-")); });
afterEach(() => {
  getDatabase().prepare("DELETE FROM harness_workspace_leases").run();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("durable Pi workspace ownership", () => {
  it("temporarily hands ownership to a peer without admitting another writer", async () => {
    const source = await acquirePiWorkspace(workspace, new AbortController().signal);
    source.attachChild(process.pid);
    let peerLease: Parameters<Parameters<typeof source.lend>[0]>[0] | undefined;
    await source.lend(async peer => {
      peerLease = peer;
      expect(() => source.assertActive()).toThrow("waiting for its peer");
      expect(() => source.attachChild(process.pid)).toThrow("waiting for its peer");
      peer.attachChild(process.pid);
      const waiting = new AbortController();
      const next = acquirePiWorkspace(workspace, waiting.signal);
      const rejected = expect(next).rejects.toThrow();
      waiting.abort();
      await rejected;
      await expect(peer.lend(async () => {})).rejects.toThrow("Nested");
      peer.release();
    });
    expect(() => source.assertActive()).not.toThrow();
    expect(() => peerLease?.assertActive()).toThrow("handoff has ended");
    expect(getDatabase().prepare("SELECT child_pid,status FROM harness_workspace_leases").get()).toEqual({ child_pid: process.pid, status: "held" });
    source.release();
  });

  it("does not return ownership to the source without a peer teardown receipt", async () => {
    const source = await acquirePiWorkspace(workspace, new AbortController().signal);
    source.attachChild(process.pid);
    await expect(source.lend(async peer => { peer.attachChild(process.pid); })).rejects.toThrow("teardown is unconfirmed");
    expect(() => source.assertActive()).toThrow("teardown is unconfirmed");
    source.release();
    await expect(acquirePiWorkspace(workspace, new AbortController().signal)).rejects.toThrow("could not be stopped");
  });

  it("restores the source if peer configuration fails before launching a process", async () => {
    const source = await acquirePiWorkspace(workspace, new AbortController().signal);
    await expect(source.lend(async () => { throw new Error("bad configuration"); })).rejects.toThrow("bad configuration");
    expect(() => source.assertActive()).not.toThrow();
    source.release();
  });
  it("never admits two owners and removes aborted waiters", async () => {
    const first = await acquirePiWorkspace(workspace, new AbortController().signal);
    first.attachChild(process.pid);
    const waiting = new AbortController();
    const next = acquirePiWorkspace(workspace, waiting.signal);
    const rejected = expect(next).rejects.toThrow();
    waiting.abort();
    await rejected;
    expect(getDatabase().prepare("SELECT COUNT(*) AS count FROM harness_workspace_leases").get()).toEqual({ count: 1 });
    first.release();
    first.release();
    const replacement = await acquirePiWorkspace(workspace, new AbortController().signal);
    replacement.release();
  });

  it("fails closed after unconfirmed cleanup, even if release is called", async () => {
    const first = await acquirePiWorkspace(workspace, new AbortController().signal);
    first.poison();
    first.release();
    await expect(acquirePiWorkspace(workspace, new AbortController().signal)).rejects.toThrow("could not be stopped");
  });
  it("does not infer descendant exit from dead owner and child PIDs after a crash", async () => {
    const deadPid = 0x3fffffff;
    expect(() => process.kill(deadPid, 0)).toThrow();
    const physical = fs.realpathSync.native(workspace);
    const key = process.platform === "win32" ? physical.toLowerCase() : physical;
    getDatabase().prepare("INSERT INTO harness_workspace_leases (workspace_key,token,owner_pid,child_pid,status,created_at) VALUES (?,?,?,?,?,?)")
      .run(key, "crashed-owner", deadPid, deadPid, "held", 1);
    await expect(acquirePiWorkspace(workspace, new AbortController().signal)).rejects.toThrow("without a teardown receipt");
    expect(getDatabase().prepare("SELECT status FROM harness_workspace_leases WHERE workspace_key=?").get(key)).toEqual({ status: "poisoned" });
  });
  it("can reclaim a dead owner that never launched a child", async () => {
    const deadPid = 0x3fffffff;
    expect(() => process.kill(deadPid, 0)).toThrow();
    const physical = fs.realpathSync.native(workspace);
    const key = process.platform === "win32" ? physical.toLowerCase() : physical;
    getDatabase().prepare("INSERT INTO harness_workspace_leases (workspace_key,token,owner_pid,status,created_at) VALUES (?,?,?,?,?)")
      .run(key, "pre-start-crash", deadPid, "held", 1);
    const next = await acquirePiWorkspace(workspace, new AbortController().signal);
    next.release();
    expect(getDatabase().prepare("SELECT COUNT(*) AS count FROM harness_workspace_leases").get()).toEqual({ count: 0 });
  });
});
