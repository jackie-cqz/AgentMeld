import { describe, expect, it } from "vitest";
import { PiEventProjection } from "./events";

describe("Pi event projection contract", () => {
  it("keeps thinking, text and later messages in different platform parts", () => {
    const projection = new PiEventProjection("conversation", "model");
    const events = [];
    for (const text of ["first", "second"]) {
      events.push(...projection.consume({ type: "message_start", message: { role: "assistant" } }));
      for (const [index, kind] of ["thinking", "text"].entries()) {
        events.push(...projection.consume({ type: "message_update", assistantMessageEvent: { type: `${kind}_delta`, contentIndex: index, delta: text } }));
      }
      events.push(...projection.consume({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: text }, { type: "text", text }], stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 2 } } }));
    }
    expect(events.filter(event => event.type === "part.start").map(event => event.partIndex)).toEqual([0, 1, 2, 3]);
    expect(events.filter(event => event.type === "part.end")).toHaveLength(4);
    expect(projection.usage()).toEqual({ modelId: "model", inputTokens: 24, outputTokens: 10 });
  });

  it.each(["error", "length", "aborted"])("does not turn %s into successful completion", stopReason => {
    const projection = new PiEventProjection("conversation", "model");
    expect(() => projection.consume({ type: "message_end", message: { role: "assistant", content: [], stopReason } })).toThrow();
    expect(projection.usage()).toBeNull();
  });

  it("rejects deltas after end and inconsistent committed content", () => {
    const projection = new PiEventProjection("conversation", "model");
    projection.consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "prefix" } });
    expect(() => projection.consume({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "different" }] } })).toThrow("prefix");
    projection.consume({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } });
    expect(() => projection.consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "late" } })).toThrow("active content block");
  });

  it("treats an absent or synthetic zero usage as unknown", () => {
    const projection = new PiEventProjection("conversation", "model");
    projection.consume({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 0, output: 0 } } });
    expect(projection.usage()).toBeNull();
  });
  it("classifies authentication failures without persisting provider diagnostics", () => {
    const projection = new PiEventProjection("conversation", "model");
    expect(() => projection.consume({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 unauthorized: private provider diagnostic" } })).toThrow("authentication failed");
  });
});
