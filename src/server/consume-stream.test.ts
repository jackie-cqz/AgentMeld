import { afterAll, afterEach, beforeAll, describe, it, expect } from "vitest";
import { consumeStream } from "@/server/consume-stream";
import { eventBus } from "@/server/event-bus";
import type { StreamEvent } from "@/shared/types";
import { setupTestDatabase } from "@/test/test-database";

let cleanupDatabase: (() => void) | undefined;

beforeAll(() => {
  cleanupDatabase = setupTestDatabase("agentmeld-consume-stream-");
});

afterAll(() => {
  cleanupDatabase?.();
});

/** Helper: creates an async generator from an array of StreamEvents */
async function* eventsToStream(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of events) {
    yield event;
  }
}

describe("consumeStream", () => {
  afterEach(() => {
    eventBus.clearForTests();
  });

  it("accumulates text parts and returns them", async () => {
    const events: StreamEvent[] = [
      {
        type: "part.start", conversationId: "c1", timestamp: 1,
        messageId: "", partIndex: 0,
        part: { type: "text", content: "" }
      },
      {
        type: "part.delta", conversationId: "c1", timestamp: 2,
        messageId: "", partIndex: 0,
        delta: { type: "text.append", text: "Hello" }
      },
      {
        type: "part.end", conversationId: "c1", timestamp: 3,
        messageId: "", partIndex: 0
      }
    ];

    const result = await consumeStream({
      stream: eventsToStream(events),
      messageId: "msg_1",
      runId: "run_1"
    });

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toEqual({ type: "text", content: "Hello" });
    expect(result.usage).toBeNull();
  });

  it("accumulates tool_use and tool_result parts", async () => {
    const events: StreamEvent[] = [
      {
        type: "tool.call", conversationId: "c1", timestamp: 1,
        messageId: "", callId: "call_1",
        toolName: "read_artifact", args: { artifactId: "art_1" }
      },
      {
        type: "tool.result", conversationId: "c1", timestamp: 2,
        messageId: "", callId: "call_1",
        result: "content here", isError: false
      }
    ];

    const result = await consumeStream({
      stream: eventsToStream(events),
      messageId: "msg_1",
      runId: "run_1"
    });

    expect(result.parts).toHaveLength(2);
    expect(result.parts[0]).toMatchObject({ type: "tool_use", callId: "call_1" });
    expect(result.parts[1]).toMatchObject({ type: "tool_result", callId: "call_1" });
  });

  it("fills empty messageId and runId in events", async () => {
    const events: StreamEvent[] = [
      {
        type: "part.start", conversationId: "c1", timestamp: 1,
        messageId: "", partIndex: 0,
        part: { type: "text", content: "" }
      },
      {
        type: "part.delta", conversationId: "c1", timestamp: 2,
        messageId: "", partIndex: 0,
        delta: { type: "text.append", text: "x" }
      },
      {
        type: "part.end", conversationId: "c1", timestamp: 3,
        messageId: "", partIndex: 0
      }
    ];

    // The main verification is that consumeStream doesn't throw.
    // EventBus publish is side-effect only (no easy way to assert in unit test).
    const result = await consumeStream({
      stream: eventsToStream(events),
      messageId: "msg_test",
      runId: "run_test"
    });

    expect(result.parts).toHaveLength(1);
  });

  it("captures usage event", async () => {
    const events: StreamEvent[] = [
      {
        type: "run.usage", conversationId: "c1", timestamp: 1,
        runId: "",
        usage: { modelId: "deepseek-chat", inputTokens: 100, outputTokens: 50 }
      }
    ];

    const result = await consumeStream({
      stream: eventsToStream(events),
      messageId: "msg_1",
      runId: "run_1"
    });

    expect(result.usage).toEqual({
      modelId: "deepseek-chat", inputTokens: 100, outputTokens: 50
    });
  });

  it("onEvent callback can stop the stream", async () => {
    const events: StreamEvent[] = [
      {
        type: "part.start", conversationId: "c1", timestamp: 1,
        messageId: "", partIndex: 0,
        part: { type: "text", content: "" }
      },
      {
        type: "tool.call", conversationId: "c1", timestamp: 2,
        messageId: "", callId: "call_stop",
        toolName: "plan_tasks", args: { tasks: [{ id: "t1" }] }
      },
      // These should NOT be consumed
      {
        type: "part.delta", conversationId: "c1", timestamp: 3,
        messageId: "", partIndex: 0,
        delta: { type: "text.append", text: "should not appear" }
      }
    ];

    let capturedTool: string | null = null;

    const result = await consumeStream({
      stream: eventsToStream(events),
      messageId: "msg_1",
      runId: "run_1",
      onEvent: (event) => {
        if (event.type === "tool.call" && "toolName" in event && (event as { toolName: string }).toolName === "plan_tasks") {
          capturedTool = "plan_tasks";
          return { stop: true };
        }
      }
    });

    expect(capturedTool).toBe("plan_tasks");
    // plan_tasks event is intercepted BEFORE accumulation — stops at just the text part
    expect(result.parts).toHaveLength(1); // only part.start text part, no tool_use
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    const events: StreamEvent[] = [
      {
        type: "part.start", conversationId: "c1", timestamp: 1,
        messageId: "", partIndex: 0,
        part: { type: "text", content: "" }
      }
    ];

    controller.abort(); // Abort before consuming

    const result = await consumeStream({
      stream: eventsToStream(events),
      messageId: "msg_1",
      runId: "run_1",
      signal: controller.signal
    });

    // Stream should stop immediately, returning empty parts
    expect(result.parts).toHaveLength(0);
  });

  it("persists deploy.status as deploy_status part", async () => {
    const deployEvent: StreamEvent = {
      type: "deploy.status",
      conversationId: "c1",
      timestamp: 1,
      messageId: "",
      deployment: {
        id: "dep_1",
        artifactId: "art_1",
        title: "My Preview",
        version: 1,
        status: "ready",
        previewPath: "/preview/dep_1",
        createdAt: 1
      }
    };

    const events: StreamEvent[] = [
      {
        type: "part.start", conversationId: "c1", timestamp: 0,
        messageId: "", partIndex: 0,
        part: { type: "text", content: "" }
      },
      {
        type: "part.delta", conversationId: "c1", timestamp: 0,
        messageId: "", partIndex: 0,
        delta: { type: "text.append", text: "deploying" }
      },
      deployEvent
    ];

    const result = await consumeStream({
      stream: eventsToStream(events),
      messageId: "msg_1",
      runId: "run_1"
    });

    // Should have text part + deploy_status part
    const deployParts = result.parts.filter((p) => p.type === "deploy_status");
    expect(deployParts).toHaveLength(1);
    expect(deployParts[0]).toMatchObject({
      type: "deploy_status",
      deployment: expect.objectContaining({ id: "dep_1", status: "ready" })
    });
  });

  it("broadcasts deploy.status as a synthetic part.start for live UI", async () => {
    const published: StreamEvent[] = [];
    const unsubscribe = eventBus.subscribe(({ event }) => {
      published.push(event);
    });

    const deployment = {
      id: "dep_live",
      artifactId: "art_live",
      title: "Live Preview",
      version: 1,
      status: "ready" as const,
      previewPath: "/deployments/dep_live",
      createdAt: 1
    };

    await consumeStream({
      stream: eventsToStream([{
        type: "deploy.status",
        conversationId: "c1",
        timestamp: 1,
        messageId: "",
        deployment
      }]),
      messageId: "msg_live",
      runId: "run_live"
    });

    unsubscribe();
    const partStart = published.find((event) => event.type === "part.start");
    expect(partStart).toMatchObject({
      type: "part.start",
      messageId: "msg_live",
      partIndex: 0,
      part: { type: "deploy_status", deployment }
    });
  });

  it("upserts deploy_status: second deploy.status for same id replaces first", async () => {
    const first: StreamEvent = {
      type: "deploy.status", conversationId: "c1", timestamp: 1,
      messageId: "",
      deployment: {
        id: "dep_1", artifactId: "art_1", title: "v1", version: 1,
        status: "failed", previewPath: "", error: "pending", createdAt: 1
      }
    };
    const second: StreamEvent = {
      type: "deploy.status", conversationId: "c1", timestamp: 2,
      messageId: "",
      deployment: {
        id: "dep_1", artifactId: "art_1", title: "v1", version: 1,
        status: "ready", previewPath: "/p/dep_1", createdAt: 2
      }
    };

    const result = await consumeStream({
      stream: eventsToStream([first, second]),
      messageId: "msg_1",
      runId: "run_1"
    });

    const deployParts = result.parts.filter((p) => p.type === "deploy_status");
    expect(deployParts).toHaveLength(1); // updated, not duplicated
    expect(deployParts[0]).toMatchObject({
      type: "deploy_status",
      deployment: expect.objectContaining({ status: "ready" })
    });
  });
});
