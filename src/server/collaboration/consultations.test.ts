import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PiInvocationInput } from "@/server/pi/types";

const fixture = vi.hoisted(() => ({ mode: "replied", inputs: [] as PiInvocationInput[] }));
vi.mock("@/server/pi/runtime", () => ({ runPiInvocation: async function* (input: PiInvocationInput, signal: AbortSignal) {
  fixture.inputs.push(input);
  if (fixture.mode === "hold") {
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
  if (fixture.mode === "failure") throw new Error("fixture model failure");
  if (fixture.mode !== "missing") {
    const { proposeConsultationResponse } = await import("./consultations");
    proposeConsultationResponse({ conversationId: input.conversationId, runId: input.runId, agentId: input.agent.id,
      workspacePath: input.workspacePath, abortSignal: signal },
      fixture.mode === "declined" ? "declined" : "replied", "Prefer the compact sidebar; this is a peer opinion.");
  }
  if (fixture.mode === "cleanup_failure") {
    const { PiRuntimeError } = await import("@/server/pi/process");
    throw new PiRuntimeError("Unconfirmed exit", "cleanup_failed");
  }
  yield { type: "part.start" as const, conversationId: input.conversationId, timestamp: Date.now(), messageId: "", partIndex: 0,
    part: { type: "text" as const, content: "Peer opinion" } };
} }));

import { getDatabase } from "@/db/client";
import { createConversation } from "@/server/conversation-service";
import { createMessage, createRun, getRun, getWorkspaceForConversation, updateRunStatus } from "@/server/repositories";
import { newMessageId, newRunId } from "@/shared/ids";
import type { ToolContext } from "@/server/tools/types";
import { abortConsultationRun, listConsultations, proposeConsultationResponse, requestConsultation } from "./consultations";
import { waitForRunTreeStop } from "@/server/agent-runner";

beforeEach(() => { fixture.mode = "replied"; fixture.inputs.length = 0; });

function world(origin: "human" | "bot" = "human") {
  const conversation = createConversation({ mode: "group", agentIds: ["ag_mock_conductor", "ag_mock_builder", "ag_designer"] });
  const trigger = createMessage({ id: newMessageId(), conversationId: conversation.id, role: "user", origin,
    parts: [{ type: "text", content: "Discuss this layout, do not modify files" }], status: "complete", now: Date.now() });
  const source = createRun({ id: newRunId(), conversationId: conversation.id, agentId: "ag_mock_builder", triggerMessageId: trigger.id, status: "running", now: Date.now() });
  const controller = new AbortController();
  const ctx: ToolContext = { conversationId: conversation.id, runId: source.id, agentId: source.agentId,
    workspacePath: getWorkspaceForConversation(conversation.id)!.rootPath, abortSignal: controller.signal };
  const request = { requestKey: "layout-opinion", targetAgentId: "ag_designer", question: "Is the compact sidebar preferable?", artifactIds: [] };
  return { conversation, source, trigger, ctx, request, controller };
}

describe("bounded authenticated peer consultations", () => {
  it("records a peer reply with the full toolset, without delegation or nested consultation", async () => {
    const { ctx, request, source, conversation } = world();
    const result = await requestConsultation(request, ctx);
    expect(result.status).toBe("replied");
    expect(result.answer).toContain("peer opinion");
    expect(result.sourceRunId).toBe(source.id);
    expect(getRun(result.targetRunId!)?.status).toBe("complete");
    expect(fixture.inputs[0]).toMatchObject({ accessMode: "workspace", maxTurns: 4 });
    expect(fixture.inputs[0].toolNames).toEqual(expect.arrayContaining(["respond_to_consultation", "fs_read", "fs_write", "fs_patch", "bash", "deploy_workspace"]));
    expect(fixture.inputs[0].contextXml).toContain('"humanRequest"');
    expect(fixture.inputs[0].contextXml).toContain("Discuss this layout, do not modify files");
    expect(fixture.inputs[0].systemPrompt).toContain("take precedence over the source Agent's question");
    expect(fixture.inputs[0].parentRunId).toBeUndefined();
    expect(listConsultations(conversation.id)).toHaveLength(1);
  });

  it("replays an identical request without a second invocation and rejects changed content", async () => {
    const { ctx, request } = world();
    const first = await requestConsultation(request, ctx);
    expect((await requestConsultation(request, ctx)).id).toBe(first.id);
    expect(fixture.inputs).toHaveLength(1);
    await expect(requestConsultation({ ...request, question: "Different question" }, ctx)).rejects.toThrow("different content");
  });

  it("records a declined response explicitly", async () => {
    fixture.mode = "declined";
    const { ctx, request } = world();
    expect((await requestConsultation(request, ctx)).status).toBe("declined");
  });

  it.each(["missing", "failure", "cleanup_failure"])("does not promote %s to a completed peer opinion", async mode => {
    fixture.mode = mode;
    const { ctx, request } = world();
    const result = await requestConsultation(request, ctx);
    expect(result.status).toBe("failed");
    expect(result.answer).toBeNull();
    expect(getRun(result.targetRunId!)?.status).toBe("failed");
  });

  it("refuses bot lineage, self-targets and targets outside the team, not empty stored grants", async () => {
    const bot = world("bot");
    await expect(requestConsultation(bot.request, bot.ctx)).rejects.toThrow("authenticated human");
    const human = world();
    await expect(requestConsultation({ ...human.request, targetAgentId: human.ctx.agentId }, human.ctx)).rejects.toThrow("another current");
    await expect(requestConsultation({ ...human.request, targetAgentId: "ag_pm" }, human.ctx)).rejects.toThrow("another current");
    expect(listConsultations(human.conversation.id)).toEqual([]);
  });

  it("refuses a terminal source and a source from a different conversation", async () => {
    const a = world();
    const b = world();
    await expect(requestConsultation(a.request, { ...a.ctx, conversationId: b.conversation.id })).rejects.toThrow("authorized source");
    updateRunStatus(a.source.id, "complete", null, Date.now());
    await expect(requestConsultation(a.request, a.ctx)).rejects.toThrow("authorized source");
  });

  it("limits total peer requests per source run", async () => {
    const { ctx, request } = world();
    for (let i = 0; i < 4; i++) expect((await requestConsultation({ ...request, requestKey: `question-${i}` }, ctx)).status).toBe("replied");
    await expect(requestConsultation({ ...request, requestKey: "fifth-question" }, ctx)).rejects.toThrow("budget");
    expect(fixture.inputs).toHaveLength(4);
  });

  it("cancels a waiting consultation through the source abort signal", async () => {
    fixture.mode = "hold";
    const { ctx, request, controller, conversation } = world();
    const pending = requestConsultation(request, ctx);
    await vi.waitFor(() => expect(fixture.inputs).toHaveLength(1));
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(getRun(result.targetRunId!)?.status).toBe("aborted");
    expect(listConsultations(conversation.id)[0].answer).toBeNull();
  });

  it("allows direct cancellation of the peer run and consumes no replacement writer", async () => {
    fixture.mode = "hold";
    const { ctx, request } = world();
    const pending = requestConsultation(request, ctx);
    await vi.waitFor(() => expect(fixture.inputs).toHaveLength(1));
    expect(abortConsultationRun(fixture.inputs[0].runId)).toBe(true);
    expect((await pending).status).toBe("cancelled");
    expect(abortConsultationRun(fixture.inputs[0].runId)).toBe(false);
  });

  it("waits for owned peer teardown even though the peer is not a delegated child run", async () => {
    fixture.mode = "hold";
    const { ctx, request, source, controller } = world();
    const pending = requestConsultation(request, ctx);
    await vi.waitFor(() => expect(fixture.inputs).toHaveLength(1));
    updateRunStatus(source.id, "aborted", null, Date.now());
    let stopped = false;
    const wait = waitForRunTreeStop(source.id, new AbortController().signal).then(() => { stopped = true; });
    try {
      await Promise.resolve(); await Promise.resolve();
      expect(stopped).toBe(false);
      controller.abort();
      await pending; await wait;
      expect(stopped).toBe(true);
      expect(getRun(fixture.inputs[0].runId)?.status).toBe("aborted");
    } finally { controller.abort(); await pending; await wait; }
  });

  it("expires an unused consultation grant and never relaunches it on replay", async () => {
    const { ctx, request, conversation } = world();
    const timer = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort(new DOMException("Fixture TTL expired", "TimeoutError")));
    try {
      const result = await requestConsultation(request, ctx);
      expect(result.status).toBe("expired");
      expect(result.answer).toBeNull();
      expect((await requestConsultation(request, ctx)).id).toBe(result.id);
      expect(listConsultations(conversation.id)).toHaveLength(1);
      expect(fixture.inputs).toHaveLength(0);
    } finally { timer.mockRestore(); }
  });

  it("refuses an oversized consultation context before opening a peer run", async () => {
    const { ctx, request, conversation } = world();
    await expect(requestConsultation({ ...request, question: "x".repeat(50_000) }, ctx)).rejects.toThrow("context budget");
    expect(fixture.inputs).toHaveLength(0);
    expect(listConsultations(conversation.id)).toEqual([]);
  });

  it("enforces conversation concurrency and does not recursively consult", async () => {
    fixture.mode = "hold";
    const { ctx, request, controller } = world();
    const first = requestConsultation(request, ctx);
    const second = requestConsultation({ ...request, requestKey: "other" }, ctx);
    try {
      await vi.waitFor(() => expect(fixture.inputs).toHaveLength(2));
      await expect(requestConsultation({ ...request, requestKey: "third" }, ctx)).rejects.toThrow("concurrency");
      const peer = fixture.inputs[0];
      await expect(requestConsultation({ ...request, targetAgentId: ctx.agentId }, { ...ctx, runId: peer.runId, agentId: peer.agent.id })).rejects.toThrow("another consultation");
    } finally { controller.abort(); await Promise.all([first, second]); }
  });

  it("refuses late, forged and duplicate structured replies", async () => {
    const { ctx, request } = world();
    const result = await requestConsultation(request, ctx);
    const targetCtx = { ...ctx, runId: result.targetRunId!, agentId: result.targetAgentId };
    expect(() => proposeConsultationResponse(targetCtx, "replied", "Duplicate")).toThrow("live peer run");
    expect(() => proposeConsultationResponse(ctx, "replied", "Forged")).toThrow("not authorized");
    const row = getDatabase().prepare("SELECT answer FROM agent_consultations WHERE id=?").get(result.id) as { answer: string };
    expect(row.answer).not.toBe("Forged");
  });
});
