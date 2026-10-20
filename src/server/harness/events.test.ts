import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { consumeStream } from "@/server/consume-stream";
import { eventBus } from "@/server/event-bus";
import { projectHarnessStream } from "@/server/harness/events";
import type { HarnessEvent } from "@/server/harness/events";
import { createConversation } from "@/server/conversation-service";
import { createMessage, getMessage } from "@/server/repositories";
import { newMessageId } from "@/shared/ids";
import type { StreamEvent } from "@/shared/types";
import { setupTestDatabase } from "@/test/test-database";

/**
 * These tests prove the output half of #25 P2 is behaviour-preserving: the same
 * scripted Pi event sequence persisted through the old `StreamEvent` path and
 * through `piHarnessDriver` -> neutral `HarnessEvent` -> `projectHarnessStream`
 * must produce identical message parts, usage and live events.
 */
let cleanupDatabase: (() => void) | undefined;

beforeAll(() => {
  cleanupDatabase = setupTestDatabase("agentmeld-harness-events-");
});

afterAll(() => {
  cleanupDatabase?.();
});

afterEach(() => {
  eventBus.clearForTests();
});

async function* streamOf<T>(events: T[]): AsyncGenerator<T> {
  for (const event of events) yield event;
}

/** A representative Pi projection: text + tool activity + thinking + usage + artifact + deploy. */
function scriptedPiEvents(conversationId: string): StreamEvent[] {
  const base = { conversationId, timestamp: 1, messageId: "" };
  const artifact = {
    id: "art_harness_events",
    conversationId,
    createdByAgentId: "ag_mock_builder",
    type: "document" as const,
    title: "Fixture document",
    content: { type: "document" as const, content: "# Fixture" },
    version: 1,
    parentArtifactId: null,
    createdAt: 1,
    updatedAt: 1,
  };
  return [
    // Initial content in part.start is legal in the platform shape and must survive.
    { ...base, type: "part.start", partIndex: 0, part: { type: "text", content: "Hello " } },
    { ...base, type: "part.delta", partIndex: 0, delta: { type: "text.append", text: "world" } },
    { ...base, type: "part.end", partIndex: 0 },
    { ...base, type: "tool.call", callId: "call_1", toolName: "fs_read", args: { path: "spec.txt" } },
    { ...base, type: "tool.result", callId: "call_1", result: { ok: true, value: "spec" }, isError: false },
    { ...base, type: "part.start", partIndex: 1, part: { type: "thinking", content: "" } },
    { ...base, type: "part.delta", partIndex: 1, delta: { type: "thinking.append", text: "checked the spec" } },
    { ...base, type: "part.end", partIndex: 1 },
    { type: "artifact.create", conversationId, timestamp: 1, artifact },
    {
      ...base,
      type: "deploy.status",
      deployment: {
        id: "dep_harness_events", artifactId: artifact.id, title: "Fixture", version: 1,
        previewPath: "/deployments/dep_harness_events", status: "ready" as const, createdAt: 1,
      },
    },
    { type: "run.usage", conversationId, timestamp: 1, runId: "run_fixture", usage: { modelId: "deepseek-chat", inputTokens: 123, outputTokens: 45 } },
  ];
}

/**
 * The two paths use different platform messages, so the message id they stamp
 * differs; everything else (including the empty id used before `consumeStream`
 * fills it) must match exactly.
 */
function normalize(events: StreamEvent[]): Array<Record<string, unknown>> {
  return events.map((event) => {
    const rest = { ...(event as unknown as Record<string, unknown>) };
    delete rest.timestamp;
    return { ...rest, ...(typeof rest.messageId === "string" ? { messageId: rest.messageId ? "<message>" : "" } : {}) };
  });
}

describe("projecting neutral harness events to persisted output", () => {
  it("persists exactly what the old StreamEvent path persisted for the same engine sequence", async () => {
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const directMessage = createMessage({
      id: newMessageId(), conversationId: conversation.id, role: "agent", agentId: "ag_mock_builder",
      parts: [], status: "streaming", now: Date.now(),
    });
    const projectedMessage = createMessage({
      id: newMessageId(), conversationId: conversation.id, role: "agent", agentId: "ag_mock_builder",
      parts: [], status: "streaming", now: Date.now(),
    });

    // Baseline: the sequence as Pi emits it today, consumed directly.
    const directPublished: StreamEvent[] = [];
    const unsubscribeDirect = eventBus.subscribe(({ event }) => directPublished.push(event));
    const direct = await consumeStream({
      stream: streamOf(scriptedPiEvents(conversation.id)),
      messageId: directMessage.id,
      runId: "run_fixture",
    });
    unsubscribeDirect();

    // New path: the same sequence translated by the Pi driver, then projected by the platform.
    const projectedPublished: StreamEvent[] = [];
    const unsubscribeProjected = eventBus.subscribe(({ event }) => projectedPublished.push(event));
    const projected = await consumeStream({
      stream: projectHarnessStream(
        streamOf(scriptedPiEvents(conversation.id).map(piEventToNeutral)),
        conversation.id
      ),
      messageId: projectedMessage.id,
      runId: "run_fixture",
    });
    unsubscribeProjected();

    // Persisted output: parts, usage and the message rows are identical.
    expect(projected.parts).toEqual(direct.parts);
    expect(projected.usage).toEqual(direct.usage);
    expect(getMessage(projectedMessage.id)?.parts).toEqual(getMessage(directMessage.id)?.parts);

    // Live/broadcast output: the same StreamEvents in the same order, apart from
    // the platform-owned wall-clock timestamp.
    expect(normalize(projectedPublished)).toEqual(normalize(directPublished));
  });

  it("does not put a terminal or lifecycle event into the persisted transcript", () => {
    const lifecycle: HarnessEvent[] = [
      { type: "run.started" },
      { type: "run.stage", stage: "queued" },
      { type: "run.settled", status: "completed" },
    ];
    // Nothing to project: lifecycle stays platform-owned (callbacks / run owner).
    const projected: StreamEvent[] = [];
    return (async () => {
      for await (const event of projectHarnessStream(streamOf(lifecycle), "conv_fixture")) projected.push(event);
      expect(projected).toEqual([]);
    })();
  });

  it("rejects output for a block the driver never opened instead of silently dropping it", async () => {
    await expect((async () => {
      for await (const event of projectHarnessStream(streamOf<HarnessEvent>([
        { type: "output.delta", blockIndex: 7, kind: "text", text: "orphan" },
      ]), "conv_fixture")) void event;
    })()).rejects.toMatchObject({ name: "HarnessError", category: "protocol" });
  });

  it("keeps the platform stream shape free of Pi's contentIndex vocabulary", async () => {
    const projected: StreamEvent[] = [];
    for await (const event of projectHarnessStream(streamOf<HarnessEvent>([
      { type: "output.start", blockIndex: 3, kind: "text" },
      { type: "output.end", blockIndex: 3 },
    ]), "conv_fixture")) projected.push(event);

    expect(projected).toHaveLength(2);
    for (const event of projected) expect(event).not.toHaveProperty("contentIndex");
    expect(projected[0]).toMatchObject({ type: "part.start", partIndex: 0 });
  });
});

/**
 * Deliberately test-local Pi-like translation: the test must compare the two
 * paths, so it converts the baseline `StreamEvent` sequence into what the Pi
 * driver would have produced without depending on the driver's mock plumbing.
 */
function piEventToNeutral(event: StreamEvent): HarnessEvent {
  switch (event.type) {
    case "part.start":
      if (event.part.type !== "text" && event.part.type !== "thinking") throw new Error("fixture part kind");
      return {
        type: "output.start", blockIndex: event.partIndex, kind: event.part.type, content: event.part.content,
      };
    case "part.delta": {
      const kind = event.delta.type === "thinking.append" ? "thinking" : "text";
      const text = "text" in event.delta ? event.delta.text : "";
      return { type: "output.delta", blockIndex: event.partIndex, kind, text };
    }
    case "part.end": return { type: "output.end", blockIndex: event.partIndex };
    case "tool.call": return { type: "tool.call", callId: event.callId, toolName: event.toolName, args: event.args };
    case "tool.result": return { type: "tool.result", callId: event.callId, result: event.result, isError: event.isError === true };
    case "artifact.create": return { type: "artifact.created", artifact: event.artifact };
    case "deploy.status": return { type: "deployment.status", deployment: event.deployment };
    case "run.usage": return { type: "run.usage", usage: event.usage };
    default: throw new Error(`fixture cannot translate ${event.type}`);
  }
}
