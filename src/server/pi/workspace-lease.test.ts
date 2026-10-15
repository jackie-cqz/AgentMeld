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
});
