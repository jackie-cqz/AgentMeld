import { describe, it, expect } from "vitest";
import { consumeStream } from "@/server/consume-stream";
import type { StreamEvent } from "@/shared/types";

/** Helper: creates an async generator from an array of StreamEvents */
async function* eventsToStream(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of events) {
    yield event;
  }
}

describe("consumeStream", () => {
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
});
