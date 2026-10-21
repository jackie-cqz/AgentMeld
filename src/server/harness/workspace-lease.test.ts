import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDatabase } from "@/db/client";
import { HarnessError } from "./errors";
import { acquireWorkspaceLease, isPlatformWorkspaceLease } from "./workspace-lease";
import { toPiInvocationInput } from "./pi-driver";
import type { Agent, Conversation, Message, Workspace } from "@/shared/types";
import type { HarnessInvocationInput, HarnessWorkspaceLease } from "./types";

/**
 * The workspace lease is platform-owned (#25 P2).
 *
 * These tests drive the platform manager directly, as a second engine would,
 * rather than through Pi's historical entry point. Pi's own lease tests
 * (`src/server/pi/workspace-lease.test.ts`) still exercise the same behaviour
 * through the adapter and must keep passing unchanged.
 */

let workspace: string;
beforeEach(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-lease-")); });
afterEach(() => {
  getDatabase().prepare("DELETE FROM harness_workspace_leases").run();
  fs.rmSync(workspace, { recursive: true, force: true });
});

const signal = () => new AbortController().signal;

describe("platform-owned workspace lease", () => {
  it("excludes two owners and releases the durable receipt", async () => {
    const lease = await acquireWorkspaceLease(workspace, signal(), { ownerLabel: "Fake" });
    lease.attachChild(process.pid);
    expect(getDatabase().prepare("SELECT child_pid,status FROM harness_workspace_leases").get()).toEqual({ child_pid: process.pid, status: "held" });

    const waiting = new AbortController();
    const next = acquireWorkspaceLease(workspace, waiting.signal, { ownerLabel: "Fake" });
    const rejected = expect(next).rejects.toThrow();
    waiting.abort();
    await rejected;
    expect(getDatabase().prepare("SELECT COUNT(*) AS count FROM harness_workspace_leases").get()).toEqual({ count: 1 });

    lease.release();
    lease.release();
    expect(getDatabase().prepare("SELECT COUNT(*) AS count FROM harness_workspace_leases").get()).toEqual({ count: 0 });
    const replacement = await acquireWorkspaceLease(workspace, signal(), { ownerLabel: "Fake" });
    replacement.release();
  });

  it("lends ownership to a peer and requires a teardown receipt before returning it", async () => {
    const source = await acquireWorkspaceLease(workspace, signal(), { ownerLabel: "Fake" });
    source.attachChild(process.pid);
    await source.lend(async peer => {
      expect(() => source.assertActive()).toThrow("waiting for its peer");
      peer.attachChild(process.pid);
      expect(getDatabase().prepare("SELECT child_pid FROM harness_workspace_leases").get()).toEqual({ child_pid: process.pid });
      peer.release();
    });
    expect(() => source.assertActive()).not.toThrow();
    source.release();

    const unreleased = await acquireWorkspaceLease(workspace, signal(), { ownerLabel: "Fake" });
    unreleased.attachChild(process.pid);
    await expect(unreleased.lend(async peer => { peer.attachChild(process.pid); })).rejects.toThrow("teardown is unconfirmed");
    expect(() => unreleased.assertActive()).toThrow("teardown is unconfirmed");
    unreleased.release();
    await expect(acquireWorkspaceLease(workspace, signal(), { ownerLabel: "Fake" })).rejects.toThrow("could not be stopped");
  });

  it("poisons the durable lease after unconfirmed cleanup", async () => {
    const lease = await acquireWorkspaceLease(workspace, signal(), { ownerLabel: "Fake" });
    lease.poison();
    lease.release();
    await expect(acquireWorkspaceLease(workspace, signal(), { ownerLabel: "Fake" }))
      .rejects.toBeInstanceOf(HarnessError);
    await expect(acquireWorkspaceLease(workspace, signal(), { ownerLabel: "Fake" })).rejects.toMatchObject({
      message: expect.stringContaining("could not be stopped"),
      category: "cleanup_failed",
    });
  });

  it("uses only the supplied owner label in failure messages", async () => {
    const lease = await acquireWorkspaceLease(workspace, signal(), { ownerLabel: "Fixture Engine" });
    lease.poison();
    await expect(acquireWorkspaceLease(workspace, signal(), { ownerLabel: "Fixture Engine" })).rejects.toThrow(
      "Inspect the Fixture Engine execution before clearing its workspace lease.",
    );
  });
});

describe("cross-engine workspace handoff", () => {
  /** The smallest neutral invocation that carries a workspace lease. */
  function invocation(workspaceLease: HarnessWorkspaceLease): HarnessInvocationInput {
    return {
      conversationId: "conv_fixture",
      runId: "run_fixture",
      parentRunId: null,
      taskExecution: null,
      taskContract: null,
      agent: { id: "ag_fixture", modelProvider: "deepseek", modelId: "fixture", reasoningEffort: null } as Agent,
      conversation: { id: "conv_fixture" } as Conversation,
      workspace: { id: "ws_fixture" } as Workspace,
      triggerMessage: { id: "msg_fixture" } as Message,
      context: { systemPrompt: "", packet: { task: "", priorHistory: [], attachments: [] }, recentMessages: [] },
      tools: { names: [], required: [] },
      requirements: {},
      provider: { providerId: "deepseek", modelId: "fixture", endpoint: null, credential: null,
        revision: "fixture", reasoningEffort: null, vision: false, contextWindow: null },
      workspaceRoot: workspace,
      access: "workspace",
      workspaceLease,
    };
  }

  it("accepts a lease acquired by a non-Pi engine as Pi's ownership handoff", async () => {
    const lease = await acquireWorkspaceLease(workspace, signal(), { ownerLabel: "Fixture Engine" });
    expect(isPlatformWorkspaceLease(lease)).toBe(true);
    // Pi used to refuse any handoff it did not produce itself. The platform now
    // owns the lifecycle, so the same object crosses engines unchanged.
    expect(toPiInvocationInput(invocation(lease)).workspaceLease).toBe(lease);
    lease.release();
  });

  it("still refuses a hand-rolled lease that is not the platform's", () => {
    // A plain object cannot lend, so the platform cannot guarantee the peer
    // handoff; refuse it instead of pretending the ownership exists.
    const foreign = {
      workspacePath: workspace,
      assertActive: () => {},
      attachChild: () => {},
      release: () => {},
      poison: () => {},
    } as unknown as HarnessWorkspaceLease;
    expect(() => toPiInvocationInput(invocation(foreign))).toThrow(HarnessError);
    expect(() => toPiInvocationInput(invocation(foreign))).toThrow("not issued by the platform");
  });
});
