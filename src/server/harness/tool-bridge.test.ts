import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ evidence: [] as EvidenceRecord[] }));
vi.mock("@/server/repositories/evidence-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/repositories/evidence-repository")>();
  return { ...actual, insertEvidence: (record: EvidenceRecord) => { mocks.evidence.push(record); } };
});

import { createAgent } from "@/server/agent-service";
import { createConversation } from "@/server/conversation-service";
import { getWorkspaceForConversation, SYSTEM_RESOLVED_BY } from "@/server/repositories";
import { getDatabase } from "@/db/client";
import { newRunId } from "@/shared/ids";
import { getAllPendingWrites, rejectPendingWrite } from "@/server/pending-writes";
import { getFileWrites } from "@/server/dispatch-file-writes";
import { createPiBridge } from "@/server/pi/bridge";
import { PI_NATIVE_TO_PLATFORM } from "@/server/pi/native-tools";
import { provisionedPlatformToolNames } from "@/server/harness/tool-surface";
import { createHarnessToolBridge, HarnessToolBridgeError } from "./tool-bridge";
import type { EvidenceRecord } from "@/server/repositories/evidence-repository";
import type { TaskExecutionIdentity } from "@/shared/evidence-types";

/**
 * Parity proof for the neutral tool bridge (#25 P2).
 *
 * The Pi path is the real loopback transport; the "second engine" is an
 * in-process caller that reaches the same platform module directly. Both are
 * driven through the same fixture, so the assertions compare the platform's
 * behaviour — result shape, evidence ledger rows, approval enforcement, replay
 * protection and terminal-tool gating — not just two copies of the same code.
 */

const bridges: Array<Awaited<ReturnType<typeof createPiBridge>>> = [];
const neutralBridges: Array<ReturnType<typeof createHarnessToolBridge>> = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
  await Promise.all(neutralBridges.splice(0).map(bridge => bridge.close()));
  vi.restoreAllMocks();
});
beforeEach(() => { mocks.evidence.length = 0; });

interface Fixture {
  agent: ReturnType<typeof createAgent>;
  conversation: ReturnType<typeof createConversation>;
  workspace: NonNullable<ReturnType<typeof getWorkspaceForConversation>>;
  neutralRunId: string;
  piRunId: string;
  taskExecution: TaskExecutionIdentity;
}

let fixtureCount = 0;
function fixture(): Fixture {
  const agent = createAgent({ name: `Neutral bridge ${++fixtureCount}`, adapterName: "pi", modelId: "fixture", toolNames: [] });
  const conversation = createConversation({ mode: "single", agentIds: [agent.id] });
  const workspace = getWorkspaceForConversation(conversation.id)!;
  return {
    agent,
    conversation,
    workspace,
    neutralRunId: newRunId(),
    piRunId: newRunId(),
    taskExecution: { conductorRunId: "fixture-conductor", planId: "fixture-plan", planRevision: 0,
      taskId: "fixture-task", attemptId: "fixture-attempt", attempt: 1, contextSnapshotId: "fixture-snapshot" },
  };
}

function neutral(f: Fixture, toolNames: string[], runId = f.neutralRunId) {
  const bridge = createHarnessToolBridge({
    conversationId: f.conversation.id,
    agentId: f.agent.id,
    runId,
    workspacePath: f.workspace.rootPath,
    taskExecution: f.taskExecution,
    signal: new AbortController().signal,
    toolNames,
    source: "fake",
    engineLabel: "Fake",
    nativeFailureMessage: "Native fake tool failed.",
    access: "workspace",
  });
  neutralBridges.push(bridge);
  return bridge;
}

async function pi(f: Fixture, toolNames: string[], runId = f.piRunId) {
  const bridge = await createPiBridge({
    agent: f.agent, conversationId: f.conversation.id, runId, workspacePath: f.workspace.rootPath,
    taskExecution: f.taskExecution, taskContract: null,
    toolNames, systemPrompt: "Neutral bridge parity fixture",
  } as never, new AbortController().signal, () => {});
  bridges.push(bridge);
  const post = (route: string, body: unknown) => fetch(`${bridge.url}${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { bridge, post };
}

/** The fields that identify an evidence row's meaning (ids/timestamps excluded). */
function evidenceRows(runId: string) {
  return mocks.evidence
    .filter(record => record.childRunId === runId)
    .map(record => ({
      type: record.type, status: record.status, trustLevel: record.trustLevel,
      sourceId: record.sourceId, subjectType: record.subjectType, subjectId: record.subjectId,
      payloadJson: record.payloadJson, contentHash: record.contentHash,
    }));
}

describe("harness-neutral tool bridge", () => {
  it("exposes the platform catalogue and keeps the Pi name mapping Pi-side", async () => {
    const f = fixture();
    const platformNames = ["fs_read", "fs_write", "read_artifact", "list_team_members"];
    const toolBridge = neutral(f, platformNames);
    const piPath = await pi(f, platformNames);

    expect(toolBridge.nativeTools).toEqual(["fs_read", "fs_write"]);
    expect(toolBridge.businessTools).toEqual(["read_artifact", "list_team_members"]);
    expect(toolBridge.catalogue.map(definition => definition.name)).toEqual(["read_artifact", "list_team_members"]);
    expect(toolBridge.catalogue).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "read_artifact", parameters: expect.objectContaining({ type: "object" }) }),
    ]));

    // The transport manifest is the same platform catalogue plus Pi's own naming:
    // the bridge never learns that Pi calls `fs_read` "read".
    const manifest = await fetch(`${piPath.bridge.url}/manifest`, {
      headers: { Authorization: `Bearer ${piPath.bridge.token}` },
    }).then(response => response.json()) as { definitions: Array<{ name: string; parameters: unknown }>; native: string[] };
    expect(manifest.definitions.map(definition => definition.name)).toEqual(["read_artifact", "list_team_members"]);
    expect(manifest.definitions).toEqual(toolBridge.catalogue);
    expect(manifest.native).toEqual(["read", "write"]);
    expect(manifest.native.map(name => PI_NATIVE_TO_PLATFORM[name])).toEqual(toolBridge.nativeTools);
  });

  it("gives a second engine the same business result and the same evidence as Pi", async () => {
    const f = fixture();
    const toolNames = ["read_artifact"];
    const toolBridge = neutral(f, toolNames);
    const { bridge, post } = await pi(f, toolNames);

    const result = await toolBridge.invoke("read_artifact", { artifactId: "art_missing" }, "call_read");
    const response = await post("/tool", { callId: "call_read", name: "read_artifact", args: { artifactId: "art_missing" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(bridge.result("call_read")).toEqual(result);
    expect(result).toEqual({ ok: false, error: 'Artifact "art_missing" not found.' });

    const piEvidence = evidenceRows(f.piRunId);
    // One observation plus the platform's explicit rejection record for the
    // failed read; both paths write the same rows.
    expect(piEvidence).toHaveLength(2);
    expect(piEvidence[0]).toMatchObject({ type: "artifact_read", status: "invalid", subjectId: "art_missing" });
    expect(piEvidence[1]).toMatchObject({ type: "tool_rejected", status: "invalid", subjectId: "read_artifact" });
    expect(evidenceRows(f.neutralRunId)).toEqual(piEvidence);
  });

  it("gives a second engine the same native write result, evidence and write tracking as Pi", async () => {
    const f = fixture();
    const toolNames = ["fs_write"];
    const toolBridge = neutral(f, toolNames);
    const { bridge, post } = await pi(f, toolNames);
    const target = path.join(f.workspace.rootPath, "shared.txt");

    // Second engine: the platform admits, approves, then the engine writes bytes.
    await toolBridge.beginNative({ callId: "call_write", name: "fs_write", args: { path: "shared.txt", content: "hello" }, targetPath: "shared.txt" });
    await toolBridge.authorizeNativeChange("call_write", target, "hello");
    fs.writeFileSync(target, "hello");
    const neutralResult = await toolBridge.completeNative("call_write", { text: "wrote shared.txt", isError: false });
    // Reset the file so both engines see the same (created) starting point.
    fs.rmSync(target, { force: true });

    // Pi: the same steps over its loopback transport.
    expect((await post("/native/authorize", { callId: "call_write", name: "write", args: { path: "shared.txt", content: "hello" } })).status).toBe(200);
    expect((await post("/native/change", { callId: "call_write", path: target, content: "hello" })).status).toBe(200);
    fs.writeFileSync(target, "hello");
    expect((await post("/native/result", { callId: "call_write", result: { content: [{ type: "text", text: "wrote shared.txt" }] }, isError: false })).status).toBe(200);

    const piResult = bridge.result("call_write");
    expect(neutralResult.ok).toBe(true);
    expect(piResult?.ok).toBe(true);
    const expectedFileResult = { path: "shared.txt", absolutePath: target, bytes: 5, contentHash: expect.any(String) };
    expect(neutralResult).toMatchObject({ value: expectedFileResult });
    expect(piResult).toMatchObject({ value: expectedFileResult });
    // The one engine-labelled field names the engine that performed the write.
    expect(neutralResult).toMatchObject({ value: { applied: "fake-native" } });
    expect(piResult).toMatchObject({ value: { applied: "pi-native" } });
    const neutralValue = (neutralResult as { value: Record<string, unknown> }).value;
    const piValue = (piResult as { value: Record<string, unknown> }).value;
    expect(neutralValue.contentHash).toBe(piValue.contentHash);

    expect(getFileWrites(f.neutralRunId).has(target)).toBe(true);
    expect(getFileWrites(f.piRunId).has(target)).toBe(true);
    const piEvidence = evidenceRows(f.piRunId);
    expect(piEvidence).toHaveLength(1);
    expect(piEvidence[0]).toMatchObject({ type: "file_written", status: "valid", subjectId: "shared.txt" });
    expect(JSON.parse(piEvidence[0].payloadJson)).toMatchObject({ path: "shared.txt", action: "created" });
    expect(evidenceRows(f.neutralRunId)).toEqual(piEvidence);
  });

  it("enforces the same native approval decision for both paths", async () => {
    const f = fixture();
    getDatabase().prepare("UPDATE conversations SET fs_write_approval_mode='review' WHERE id=?").run(f.conversation.id);
    const toolBridge = neutral(f, ["fs_write"]);
    const { post } = await pi(f, ["fs_write"]);
    const target = path.join(f.workspace.rootPath, "review.txt");

    // Second engine: the change blocks on the human decision and a rejection is fatal.
    await toolBridge.beginNative({ callId: "review-fake", name: "fs_write", args: { path: "review.txt", content: "proposed" }, targetPath: "review.txt" });
    const neutralChange = toolBridge.authorizeNativeChange("review-fake", target, "proposed");
    const neutralPending = await vi.waitFor(() => {
      const pending = getAllPendingWrites().find(write => write.runId === f.neutralRunId);
      if (!pending) throw new Error("pending write not registered");
      return pending;
    });
    expect(fs.existsSync(target)).toBe(false);
    expect(rejectPendingWrite(neutralPending.id, SYSTEM_RESOLVED_BY)).toBe(true);
    await expect(neutralChange).rejects.toThrow("User rejected the native file change.");
    expect(fs.existsSync(target)).toBe(false);

    // Pi: the same pending decision, the same refusal, no bytes written.
    expect((await post("/native/authorize", { callId: "review-pi", name: "write", args: { path: "review.txt", content: "proposed" } })).status).toBe(200);
    const piChange = post("/native/change", { callId: "review-pi", path: target, content: "proposed" });
    const piPending = await vi.waitFor(() => {
      const pending = getAllPendingWrites().find(write => write.runId === f.piRunId);
      if (!pending) throw new Error("pending write not registered");
      return pending;
    });
    expect(rejectPendingWrite(piPending.id, SYSTEM_RESOLVED_BY)).toBe(true);
    const piResponse = await piChange;
    expect(piResponse.status).toBe(400);
    expect(await piResponse.json()).toMatchObject({ ok: false, error: "User rejected the native file change." });
    expect(fs.existsSync(target)).toBe(false);

    // Nothing was approved, so both runs agree there is no pending decision left.
    expect(getAllPendingWrites().filter(write => [f.neutralRunId, f.piRunId].includes(write.runId))).toEqual([]);
  });

  it("applies the same replay, terminal-tool and provisioning refusals", async () => {
    const f = fixture();
    const toolNames = ["report_task_result", "fs_write"];
    const toolBridge = neutral(f, toolNames);
    const { post } = await pi(f, toolNames);

    // Unprovisioned business tool: the call is refused, not executed.
    await expect(toolBridge.invoke("read_artifact", { artifactId: "art_missing" }, "unprovisioned"))
      .rejects.toMatchObject({ message: "Tool is not authorized for this invocation.", reason: "not_provisioned" });
    const refused = await post("/tool", { callId: "unprovisioned", name: "read_artifact", args: { artifactId: "art_missing" } });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ ok: false, error: "Tool is not authorized for this invocation." });

    // Replay protection: a consumed call id cannot be admitted twice.
    await expect(toolBridge.beginNative({ callId: "replay", name: "fs_write", args: { path: "one.txt" }, targetPath: "one.txt" }))
      .resolves.toBeTruthy();
    await expect(toolBridge.beginNative({ callId: "replay", name: "fs_write", args: { path: "one.txt" }, targetPath: "one.txt" }))
      .rejects.toThrow("Tool call ID has already been consumed.");
    expect((await post("/native/authorize", { callId: "replay", name: "write", args: { path: "one.txt" } })).status).toBe(200);
    const replay = await post("/native/authorize", { callId: "replay", name: "write", args: { path: "one.txt" } });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "Tool call ID has already been consumed." });

    // A terminal platform result ends the invocation's tool activity.
    await toolBridge.invoke("report_task_result", { status: "complete", summary: "Fixture", acceptanceResults: [] }, "report");
    await expect(toolBridge.beginNative({ callId: "after-terminal", name: "fs_write", args: { path: "late.txt" }, targetPath: "late.txt" }))
      .rejects.toThrow("This invocation already submitted its terminal platform result.");
    expect((await post("/tool", { callId: "report", name: "report_task_result", args: { status: "complete", summary: "Fixture", acceptanceResults: [] } })).status).toBe(200);
    const late = await post("/native/authorize", { callId: "late", name: "write", args: { path: "late.txt" } });
    expect(late.status).toBe(400);
    expect(await late.json()).toMatchObject({ error: "This invocation already submitted its terminal platform result." });
  });

  it("reports a refusal as a typed bridge error instead of a bare string", async () => {
    const f = fixture();
    const toolBridge = neutral(f, []);
    expect(toolBridge.businessTools).toEqual([]);
    await expect(toolBridge.invoke("read_artifact", { artifactId: "art_missing" }, "call"))
      .rejects.toBeInstanceOf(HarnessToolBridgeError);
  });
});

// Keep the tool surface itself honest while this file owns a mocked evidence sink.
describe("neutral tool surface", () => {
  it("provisions the platform native family and every registered business tool", () => {
    const names = provisionedPlatformToolNames();
    expect(names).toEqual(expect.arrayContaining(["fs_read", "fs_write", "fs_patch", "bash", "read_artifact", "write_artifact", "deploy_workspace", "web_fetch", "browser_check"]));
    expect(names).not.toContain("job_start");
    expect(names).not.toContain("plan_tasks");
    expect(names).toContain("list_team_members");
  });
});
