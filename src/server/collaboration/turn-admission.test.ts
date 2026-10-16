import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiInvocationInput } from "@/server/pi/types";

const fixture = vi.hoisted(() => ({
  inputs: [] as PiInvocationInput[],
  decision: { intent: "discussion", targetRunId: null as string | null, mode: "discussion", reason: "Fixture decision" },
  holds: new Map<string, "hold" | "cleanup_failure">(),
  consumeFollowups: false,
  followupConsumers: [] as Array<() => void>,
  stopped: [] as string[],
}));

vi.mock("@/server/pi/runtime", () => ({ runPiInvocation: async function* (input: PiInvocationInput, signal: AbortSignal) {
  fixture.inputs.push(input);
  const classification = input.systemPrompt.startsWith("AGENTMELD_TURN_CLASSIFIER_V1");
  const text = input.triggerMessage.parts.filter(part => part.type === "text").map(part => part.content).join("\n");
  const base = { conversationId: input.conversationId, timestamp: Date.now(), messageId: "", partIndex: 0 };
  if (classification) {
    yield { ...base, type: "part.delta" as const, delta: { type: "text.append" as const, text: JSON.stringify(fixture.decision) } };
    return;
  }
  input.onTaskAccepted?.();
  const holding = fixture.holds.get(text);
  if (holding) {
    const { registerPiControl } = await import("@/server/pi/controls");
    const control = registerPiControl({ runId: input.runId, signal, allowFollowup: input.accessMode === "conversation", request: async (_kind, params) => {
      const consume = () => control.observe({ type: "message_end", message: { role: "user", content: [{ type: "text", text: params.message }] } });
      fixture.followupConsumers.push(consume);
      if (fixture.consumeFollowups) consume();
    } });
    let failure: unknown;
    try {
      await new Promise<void>((_resolve, reject) => {
        const stop = () => reject(signal.reason);
        if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
      });
    } catch (error) { failure = error; }
    finally {
      control.close(); fixture.stopped.push(input.runId);
    }
    if (holding === "cleanup_failure") {
      const { PiRuntimeError } = await import("@/server/pi/process");
      throw new PiRuntimeError("Fixture teardown was not confirmed", "cleanup_failed");
    }
    if (failure) throw failure;
  }
  yield { ...base, type: "part.start" as const, part: { type: "text" as const, content: "Scoped fixture response" } };
  yield { ...base, type: "part.end" as const };
} }));

import { createConversation, getConversationPayload, sendMessage } from "@/server/conversation-service";
import { updateAgent } from "@/server/agent-service";
import { abortRun, isRunActive } from "@/server/agent-runner";
import { getRun, listMessages } from "@/server/repositories";
import { listCollaborationTurns, updateCollaborationTurn } from "./turns";
import { getDatabase } from "@/db/client";
import { resolveCollaborationTurn } from "./resolve-turn";

beforeEach(() => {
  fixture.inputs.length = 0; fixture.holds.clear(); fixture.followupConsumers.length = 0; fixture.stopped.length = 0;
  fixture.consumeFollowups = false;
  fixture.decision = { intent: "discussion", targetRunId: null, mode: "discussion", reason: "Fixture decision" };
});
afterEach(async () => {
  const ids = [...new Set(fixture.inputs.map(input => input.runId))];
  for (const id of ids) abortRun(id);
  await vi.waitFor(() => expect(ids.filter(isRunActive)).toEqual([]), { timeout: 5000 });
});

function world() {
  updateAgent("ag_mock_builder", { adapterName: "pi", modelProvider: "openai-compatible", modelId: "fixture-model", apiKey: "fixture-not-real",
    apiBaseUrl: "http://127.0.0.1:1", toolNames: ["fs_read", "fs_write", "read_artifact", "consult_agent"] });
  const conversation = createConversation({ mode: "group", agentIds: ["ag_mock_builder", "ag_designer"] });
  const send = (content: string, options: Partial<Parameters<typeof sendMessage>[0]> = {}) => sendMessage({ origin: "human", conversationId: conversation.id,
    content, mentionedAgentIds: ["ag_mock_builder"], ...options });
  const wait = async (id: string) => vi.waitFor(() => expect(isRunActive(id)).toBe(false), { timeout: 5000 });
  return { conversation, send, wait };
}

describe("human turn admission", () => {
  it("keeps the full toolset for every discussion participant without forcing a delivery plan", async () => {
    const { conversation, send, wait } = world();
    const result = await send("前端看一下布局，先别改。", { mentionedAgentIds: ["ag_mock_builder", "ag_designer"] });
    await Promise.all(result.runIds.map(wait));
    const tasks = fixture.inputs.filter(input => !input.systemPrompt.startsWith("AGENTMELD_TURN_CLASSIFIER_V1"));
    expect(tasks).toHaveLength(2);
    expect(tasks.every(input => input.accessMode === "workspace")).toBe(true);
    for (const task of tasks) {
      expect(task.toolNames).toEqual(expect.arrayContaining(["fs_read", "fs_write", "fs_patch", "write_artifact", "deploy_workspace", "bash", "consult_agent"]));
      expect(task.systemPrompt).toContain("All normal tools remain available");
      expect(task.systemPrompt).toContain("do not modify, build or deploy anything");
    }
    expect(listCollaborationTurns(conversation.id).map(turn => turn.status)).toEqual(["applied", "applied"]);
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM conductor_plans WHERE conversation_id=?").get(conversation.id)).toEqual({ n: 0 });
  });

  it("vetoes a model-proposed execution when the human explicitly said discussion only", async () => {
    fixture.decision = { intent: "new_task", mode: "execution", targetRunId: null, reason: "Wrong fixture proposal" };
    const { send, wait } = world();
    const result = await send("比较一下，先别改。");
    await wait(result.runIds[0]);
    expect(fixture.inputs.at(-1)?.accessMode).toBe("workspace");
    expect(fixture.inputs.at(-1)?.systemPrompt).toContain("PLATFORM DISCUSSION:");
  });

  it("does not let a deploy-looking string bypass an explicit discussion action", async () => {
    const { send, wait } = world();
    const result = await send("/deploy", { action: "discussion" });
    expect(result.runIds).toHaveLength(1);
    await wait(result.runIds[0]);
    expect(fixture.inputs.at(-1)?.accessMode).toBe("workspace");
    expect(fixture.inputs.at(-1)?.systemPrompt).toContain("PLATFORM DISCUSSION:");
    expect(fixture.inputs.at(-1)?.toolNames).toContain("deploy_workspace");
  });

  it("handles an explicit progress query without restarting or interrupting its target", async () => {
    const { send, wait, conversation } = world();
    fixture.holds.set("Build the original task", "hold");
    const original = await send("Build the original task", { action: "new_task" });
    await vi.waitFor(() => expect(fixture.inputs).toHaveLength(1));
    const result = await send("进度如何？", { action: "progress", targetRunId: original.runIds[0] });
    await wait(result.runIds[0]);
    expect(fixture.inputs).toHaveLength(1);
    expect(isRunActive(original.runIds[0])).toBe(true);
    expect(listCollaborationTurns(conversation.id).find(turn => turn.runId === result.runIds[0])?.status).toBe("applied");
  });

  it("stops the previous writer before recompiling a correction into a fresh invocation", async () => {
    const { send, wait, conversation } = world();
    fixture.holds.set("Build the original task", "hold");
    const original = await send("Build the original task", { action: "new_task" });
    await vi.waitFor(() => expect(fixture.inputs).toHaveLength(1));
    const corrected = await send("Change the primary color to blue", { action: "correction", targetRunId: original.runIds[0] });
    await wait(corrected.runIds[0]);
    expect(fixture.stopped).toContain(original.runIds[0]);
    expect(getRun(original.runIds[0])?.status).toBe("aborted");
    const replacement = fixture.inputs.find(input => input.runId === corrected.runIds[0])!;
    expect(replacement.contextXml).toContain("Build the original task");
    expect(replacement.contextXml).toContain("Change the primary color to blue");
    const turn = listCollaborationTurns(conversation.id).find(item => item.runId === corrected.runIds[0])!;
    expect(turn.status).toBe("applied");
    expect(turn.contextSnapshotId).toBeTruthy();
  });

  it("does not start a replacement when the old writer lacks a teardown receipt", async () => {
    const { send, wait, conversation } = world();
    fixture.holds.set("Unconfirmed old writer", "cleanup_failure");
    const original = await send("Unconfirmed old writer", { action: "new_task" });
    await vi.waitFor(() => expect(fixture.inputs).toHaveLength(1));
    const corrected = await send("Change the task", { action: "correction", targetRunId: original.runIds[0] });
    await wait(corrected.runIds[0]);
    expect(fixture.inputs).toHaveLength(1);
    expect(getRun(corrected.runIds[0])?.status).toBe("failed");
    expect(listCollaborationTurns(conversation.id).find(turn => turn.runId === corrected.runIds[0])?.status).toBe("rejected");
  });

  it("keeps a writer supplement executable instead of silently demoting it to discussion", async () => {
    const { send, wait } = world();
    fixture.holds.set("Original executable goal", "hold");
    const original = await send("Original executable goal", { action: "new_task" });
    await vi.waitFor(() => expect(fixture.inputs).toHaveLength(1));
    const next = await send("Also preserve keyboard navigation", { action: "supplement", targetRunId: original.runIds[0] });
    await wait(next.runIds[0]);
    const replacement = fixture.inputs.find(input => input.runId === next.runIds[0])!;
    expect(fixture.stopped).toContain(original.runIds[0]);
    expect(replacement.accessMode).not.toBe("conversation");
    expect(replacement.contextXml).toContain("Original executable goal");
    expect(replacement.contextXml).toContain("Also preserve keyboard navigation");
  });

  it("stops a live writer when the human changes the request to discussion only", async () => {
    const { send, wait } = world();
    fixture.holds.set("Change the application", "hold");
    const original = await send("Change the application", { action: "new_task" });
    await vi.waitFor(() => expect(fixture.inputs).toHaveLength(1));
    const next = await send("先别改，先讨论方案。", { targetRunId: original.runIds[0], action: "correction" });
    await wait(next.runIds[0]);
    expect(fixture.stopped).toContain(original.runIds[0]);
    expect(fixture.inputs.find(input => input.runId === next.runIds[0])?.systemPrompt).toContain("PLATFORM DISCUSSION:");
  });

  it("appends immutable context snapshots without regressing an applied receipt", async () => {
    const { send, wait, conversation } = world();
    const result = await send("Discuss a layout", { action: "discussion" });
    await wait(result.runIds[0]);
    const turn = listCollaborationTurns(conversation.id)[0];
    const before = getDatabase().prepare("SELECT * FROM collaboration_context_snapshots WHERE turn_id=? ORDER BY created_at").all(turn.id);
    expect(before).toHaveLength(1);
    updateCollaborationTurn(turn.id, { status: "queued", context: JSON.stringify({ packet: "later captured invocation" }) });
    const after = getDatabase().prepare("SELECT * FROM collaboration_context_snapshots WHERE turn_id=? ORDER BY created_at").all(turn.id) as Array<Record<string, unknown>>;
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]);
    expect(after[1].previous_snapshot_id).toBe(after[0].id);
    expect(listCollaborationTurns(conversation.id)[0].status).toBe("applied");
    expect(getConversationPayload(conversation.id)!.collaborationTurns[0].context).toBeNull();
  });

  it("binds an ambiguous turn's explicit resolution to a human and deduplicates replay", async () => {
    const { send, wait, conversation } = world();
    fixture.decision = { intent: "clarify", mode: "discussion", targetRunId: null, reason: "Ambiguous fixture request" };
    const original = await send("Maybe change this later");
    await wait(original.runIds[0]);
    const turn = listCollaborationTurns(conversation.id).find(turn => turn.runId === original.runIds[0])!;
    expect(turn.status).toBe("needs_confirmation");
    await expect(resolveCollaborationTurn(turn.id, "new_task", undefined, { kind: "anonymous" })).rejects.toThrow("Authenticated");
    const owner = { kind: "owner-session" as const, sessionId: "fixture-resolution", createdAt: 1 };
    const resolved = await resolveCollaborationTurn(turn.id, "discussion", undefined, owner);
    const replay = await resolveCollaborationTurn(turn.id, "discussion", undefined, owner);
    expect(replay.runIds).toEqual(resolved.runIds);
    await wait(resolved.runIds[0]);
    const saved = listCollaborationTurns(conversation.id).find(item => item.id === turn.id)!;
    expect(saved.status).toBe("resolved");
    expect(saved.resolvedBy).toContain("fixture-resolution");
    expect(saved.resolutionMessageId).toBe(resolved.message.id);
    await expect(resolveCollaborationTurn(turn.id, "new_task", undefined, owner)).rejects.toMatchObject({ code: "SUBMISSION_CONFLICT" });
    expect(listMessages(conversation.id).filter(message => message.role === "user")).toHaveLength(2);
    expect(fixture.inputs.filter(input => !input.systemPrompt.startsWith("AGENTMELD_TURN_CLASSIFIER_V1"))).toHaveLength(1);
  });

  it("queues a new mutable task rather than starting a second task for the same Agent", async () => {
    const { send, wait, conversation } = world();
    fixture.holds.set("First task", "hold");
    const original = await send("First task", { action: "new_task" });
    await vi.waitFor(() => expect(fixture.inputs).toHaveLength(1));
    const next = await send("Second independent task", { action: "new_task" });
    await vi.waitFor(() => expect(listCollaborationTurns(conversation.id).find(turn => turn.runId === next.runIds[0])?.status).toBe("queued"));
    expect(fixture.inputs).toHaveLength(1);
    abortRun(original.runIds[0]);
    await wait(next.runIds[0]);
    expect(fixture.inputs).toHaveLength(2);
    expect(getRun(next.runIds[0])?.status).toBe("complete");
  });

  it("stops a full-tool discussion before applying a supplement in a fresh invocation", async () => {
    const { send, wait, conversation } = world();
    fixture.holds.set("Discuss the layout", "hold");
    const original = await send("Discuss the layout", { action: "discussion" });
    await vi.waitFor(() => expect(fixture.inputs).toHaveLength(1));
    const supplement = await send("Focus on the compact option", { action: "supplement", targetRunId: original.runIds[0] });
    await wait(supplement.runIds[0]);
    expect(listCollaborationTurns(conversation.id).find(turn => turn.runId === supplement.runIds[0])?.status).toBe("applied");
    expect(fixture.inputs).toHaveLength(2);
    expect(fixture.followupConsumers).toHaveLength(0);
    expect(fixture.stopped).toContain(original.runIds[0]);
    expect(isRunActive(original.runIds[0])).toBe(false);
    expect(fixture.inputs[1].contextXml).toContain("Focus on the compact option");
  });

  it("does not duplicate an accepted send when the client retries its request identity", async () => {
    const { send, wait, conversation } = world();
    const first = await send("Discuss this", { clientRequestId: "stable-request", action: "discussion" });
    const replay = await send("Discuss this", { clientRequestId: "stable-request", action: "discussion" });
    expect(replay.message.id).toBe(first.message.id);
    expect(replay.runIds).toEqual(first.runIds);
    await wait(first.runIds[0]);
    expect(listMessages(conversation.id).filter(message => message.role === "user")).toHaveLength(1);
    expect(fixture.inputs).toHaveLength(1);
    await expect(send("Different content", { clientRequestId: "stable-request", action: "discussion" })).rejects.toMatchObject({ code: "SUBMISSION_CONFLICT" });
  });

  it("rejects bot control and cross-conversation targets before writing anything", async () => {
    const a = world(); const b = world();
    const source = await a.send("Discuss", { action: "discussion" });
    await a.wait(source.runIds[0]);
    await expect(b.send("Cancel it", { action: "cancel", targetRunId: source.runIds[0] })).rejects.toThrow("this conversation");
    await expect(b.send("Cancel it", { origin: "bot", action: "cancel" })).rejects.toThrow("Only human");
    expect(getConversationPayload(b.conversation.id)?.messages).toHaveLength(0);
  });
});
