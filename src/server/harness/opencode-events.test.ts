import { describe, expect, it } from "vitest";
import type {
  ApiError,
  AssistantMessage,
  Event,
  Part,
  ProviderAuthError,
  TextPart,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/client";
import type { HarnessEvent } from "./events";
import { OpenCodeEventProjection, toHarnessError } from "./opencode-events";

const SESSION = "ses_fixture";

function userMessage(id = "msg_user"): UserMessage {
  return {
    id,
    sessionID: SESSION,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "agentmeld", modelID: "fixture-model" },
  };
}

function assistantMessage(id = "msg_assistant", overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id,
    sessionID: SESSION,
    role: "assistant",
    time: { created: 2 },
    parentID: "msg_user",
    modelID: "fixture-model",
    providerID: "agentmeld",
    mode: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function messageUpdated(info: UserMessage | AssistantMessage): Event {
  return { type: "message.updated", properties: { info } };
}

function partUpdated(part: Part, delta?: string): Event {
  return { type: "message.part.updated", properties: { part, ...(delta !== undefined ? { delta } : {}) } };
}

function textPart(id: string, text: string, overrides: Partial<TextPart> = {}): TextPart {
  return { id, sessionID: SESSION, messageID: "msg_assistant", type: "text", text, ...overrides };
}

function toolPart(state: ToolPart["state"], overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    id: "prt_tool",
    sessionID: SESSION,
    messageID: "msg_assistant",
    type: "tool",
    callID: "call_1",
    tool: "read",
    state,
    ...overrides,
  };
}

function drain(projection: OpenCodeEventProjection, events: Event[]): HarnessEvent[] {
  return events.flatMap(event => projection.observe(event));
}

describe("OpenCode event projection", () => {
  it("turns a growing text snapshot into start/delta/end events", () => {
    const projection = new OpenCodeEventProjection({ sessionId: SESSION });
    const events = drain(projection, [
      messageUpdated(assistantMessage()),
      partUpdated(textPart("prt_text", "")),
      partUpdated(textPart("prt_text", "Hel")),
      partUpdated(textPart("prt_text", "Hello")),
      partUpdated(textPart("prt_text", "Hello world")),
    ]);
    expect(events).toEqual([
      { type: "output.start", blockIndex: 0, kind: "text", content: "" },
      { type: "output.delta", blockIndex: 0, kind: "text", text: "Hel" },
      { type: "output.delta", blockIndex: 0, kind: "text", text: "lo" },
      { type: "output.delta", blockIndex: 0, kind: "text", text: " world" },
    ]);

    // Completion closes the open block exactly once.
    expect(projection.observe(partUpdated(textPart("prt_text", "Hello world", { time: { start: 1, end: 2 } })))).toEqual([
      { type: "output.end", blockIndex: 0 },
    ]);
    expect(projection.observe({ type: "session.idle", properties: { sessionID: SESSION } })).toEqual([]);
  });

  it("prefers the SDK's explicit delta over snapshot diffing", () => {
    const projection = new OpenCodeEventProjection({ sessionId: SESSION });
    expect(drain(projection, [
      messageUpdated(assistantMessage()),
      partUpdated(textPart("prt_text", "Hi", { time: { start: 1 } }), "Hi"),
    ])).toEqual([
      { type: "output.start", blockIndex: 0, kind: "text", content: "" },
      { type: "output.delta", blockIndex: 0, kind: "text", text: "Hi" },
    ]);
  });

  it("maps reasoning parts to thinking output", () => {
    const projection = new OpenCodeEventProjection({ sessionId: SESSION });
    const reasoning: Part = {
      id: "prt_reason", sessionID: SESSION, messageID: "msg_assistant", type: "reasoning",
      text: "Considering", time: { start: 1 },
    };
    expect(drain(projection, [messageUpdated(assistantMessage()), partUpdated(reasoning)])).toEqual([
      { type: "output.start", blockIndex: 0, kind: "thinking", content: "" },
      { type: "output.delta", blockIndex: 0, kind: "thinking", text: "Considering" },
    ]);
  });

  it("never projects the platform's own prompt echoed back as a user message", () => {
    const projection = new OpenCodeEventProjection({ sessionId: SESSION, expectedUserPrompt: "## Current platform task\nDo the thing" });
    const echoed: UserMessage = userMessage();
    const events = drain(projection, [
      messageUpdated(echoed),
      partUpdated({ ...textPart("prt_user", "## Current platform task\nDo the thing"), messageID: echoed.id }),
    ]);
    expect(events).toEqual([]);
    expect(projection.state()).toMatchObject({ taskAccepted: true, sawAssistantMessage: false });
  });

  it("buffers a part whose message role has not arrived yet", () => {
    const projection = new OpenCodeEventProjection({ sessionId: SESSION });
    const text: TextPart = { ...textPart("prt_text", "late"), messageID: "msg_buffered" };
    // No role yet: buffered, not leaked.
    expect(projection.observe(partUpdated(text))).toEqual([]);
    expect(projection.state().sawAssistantMessage).toBe(false);

    const events = projection.observe(messageUpdated(assistantMessage("msg_buffered")));
    expect(events).toEqual([
      { type: "output.start", blockIndex: 0, kind: "text", content: "" },
      { type: "output.delta", blockIndex: 0, kind: "text", text: "late" },
    ]);
  });

  it("projects one tool.call and one tool.result across the tool lifecycle", () => {
    const projection = new OpenCodeEventProjection({ sessionId: SESSION });
    const events = drain(projection, [
      messageUpdated(assistantMessage()),
      partUpdated(toolPart({ status: "pending", input: {}, raw: "" })),
    ]);
    // A pending call has no parsed arguments, so it is not reported yet.
    expect(events).toEqual([]);
    expect(drain(projection, [
      partUpdated(toolPart({ status: "running", input: { filePath: "/tmp/a.txt" }, time: { start: 3 } })),
      partUpdated(toolPart({
        status: "completed", input: { filePath: "/tmp/a.txt" }, output: "contents", title: "a.txt",
        metadata: {}, time: { start: 3, end: 4 },
      })),
    ])).toEqual([
      { type: "tool.call", callId: "call_1", toolName: "read", args: { filePath: "/tmp/a.txt" } },
      {
        type: "tool.result", callId: "call_1",
        result: { output: "contents", title: "a.txt", metadata: {} }, isError: false,
      },
    ]);
  });

  it("marks a failed tool result as an error, never as success", () => {
    const projection = new OpenCodeEventProjection({ sessionId: SESSION });
    const events = drain(projection, [
      messageUpdated(assistantMessage()),
      partUpdated(toolPart({ status: "pending", input: {}, raw: "" })),
      partUpdated(toolPart({
        status: "error", input: {}, error: "permission denied", metadata: { code: "EPERM" },
        time: { start: 1, end: 2 },
      })),
    ]);
    expect(events.at(-1)).toEqual({
      type: "tool.result", callId: "call_1",
      result: { error: "permission denied", metadata: { code: "EPERM" } }, isError: true,
    });
  });

  it("sums usage per assistant message without double-counting updates", () => {
    const projection = new OpenCodeEventProjection({ sessionId: SESSION });
    drain(projection, [
      messageUpdated(assistantMessage("msg_1", { tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 3 } } })),
      // The engine re-emits the message with completed counters; replace, don't add.
      messageUpdated(assistantMessage("msg_1", { tokens: { input: 20, output: 12, reasoning: 1, cache: { read: 4, write: 3 } } })),
      messageUpdated(assistantMessage("msg_2", { tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } })),
    ]);
    expect(projection.state().usage).toEqual({
      modelId: "fixture-model",
      inputTokens: 25,
      outputTokens: 15,
      cacheReadTokens: 4,
      cacheCreationTokens: 3,
    });
  });

  it("records the engine failure and the idle terminal, ignoring other sessions", () => {
    const projection = new OpenCodeEventProjection({ sessionId: SESSION });
    const auth: ProviderAuthError = { name: "ProviderAuthError", data: { providerID: "agentmeld", message: "bad key" } };
    const other: ProviderAuthError = { name: "ProviderAuthError", data: { providerID: "agentmeld", message: "other session" } };
    drain(projection, [
      { type: "session.error", properties: { sessionID: "ses_other", error: other } },
      { type: "session.error", properties: { sessionID: SESSION, error: auth } },
      { type: "session.idle", properties: { sessionID: "ses_other" } },
    ]);
    expect(projection.state()).toMatchObject({ idle: false, failure: auth });
    projection.observe({ type: "session.idle", properties: { sessionID: SESSION } });
    expect(projection.state()).toMatchObject({ idle: true });
  });

  it("accepts a user part that arrived before its message role", () => {
    const projection = new OpenCodeEventProjection({ sessionId: SESSION, expectedUserPrompt: "prompt text" });
    const user: UserMessage = userMessage("msg_early");
    expect(projection.observe(partUpdated({ id: "prt_user", sessionID: SESSION, messageID: "msg_early", type: "text", text: "prompt text" })))
      .toEqual([]);
    expect(projection.state().taskAccepted).toBe(false);
    expect(projection.observe(messageUpdated(user))).toEqual([]);
    expect(projection.state().taskAccepted).toBe(true);
  });

  it("never opens a second block for a part after it ended", () => {
    const projection = new OpenCodeEventProjection({ sessionId: SESSION });
    expect(drain(projection, [
      messageUpdated(assistantMessage()),
      partUpdated(textPart("prt_text", "done", { time: { start: 1, end: 2 } })),
    ])).toEqual([
      { type: "output.start", blockIndex: 0, kind: "text", content: "" },
      { type: "output.delta", blockIndex: 0, kind: "text", text: "done" },
      { type: "output.end", blockIndex: 0 },
    ]);
    expect(projection.observe(partUpdated(textPart("prt_text", "done again")))).toEqual([]);
  });

  it("closes every open block on abort", () => {
    const projection = new OpenCodeEventProjection({ sessionId: SESSION });
    drain(projection, [messageUpdated(assistantMessage()), partUpdated(textPart("prt_text", "partial"))]);
    expect(projection.closeAllBlocks()).toEqual([{ type: "output.end", blockIndex: 0 }]);
    expect(projection.closeAllBlocks()).toEqual([]);
  });
});

describe("OpenCode failure mapping", () => {
  it("maps provider authentication failures", () => {
    const auth: ProviderAuthError = { name: "ProviderAuthError", data: { providerID: "agentmeld", message: "expired key" } };
    expect(toHarnessError(auth)).toMatchObject({ category: "authentication", message: "expired key" });
  });

  it("splits API errors by the status codes the platform already distinguishes", () => {
    const api = (statusCode: number, message = "api failed"): ApiError => ({
      name: "APIError", data: { message, statusCode, isRetryable: false },
    });
    expect(toHarnessError(api(401)).category).toBe("authentication");
    expect(toHarnessError(api(403)).category).toBe("authentication");
    expect(toHarnessError(api(429)).category).toBe("rate_limit");
    expect(toHarnessError(api(408)).category).toBe("timeout");
    expect(toHarnessError(api(504)).category).toBe("timeout");
    expect(toHarnessError(api(500)).category).toBe("provider");
  });

  it("maps output limits, aborts and unknown errors", () => {
    expect(toHarnessError({ name: "MessageOutputLengthError", data: {} }).category).toBe("output_limit");
    expect(toHarnessError({ name: "MessageAbortedError", data: { message: "cancelled" } }).category).toBe("aborted");
    expect(toHarnessError({ name: "UnknownError", data: { message: "boom" } })).toMatchObject({
      category: "runtime",
      message: "boom",
    });
  });

  it("falls back to runtime with the source category for a name this build does not know", () => {
    const unknown = { name: "SomethingNewError", data: { message: "future" } } as never;
    expect(toHarnessError(unknown)).toMatchObject({ category: "runtime", sourceCategory: "SomethingNewError" });
  });
});
