import { describe, expect, it } from "vitest";
import { encodePiCommand, PiEventQueue, PiJsonLines } from "./protocol";

describe("Pi 0.84.2 JSONL transport", () => {
  it("preserves UTF-8 and Unicode separators across byte chunks", () => {
    const decoder = new PiJsonLines();
    const bytes = Buffer.from(encodePiCommand({ type: "message_update", text: "\u4e2d\u6587\u2028\u2029" }));
    const result = [];
    for (const byte of bytes) result.push(...decoder.push(Buffer.from([byte])));
    expect(result).toEqual([{ type: "message_update", text: "\u4e2d\u6587\u2028\u2029" }]);
    decoder.finish();
  });

  it("accepts CRLF but rejects invalid and incomplete records", () => {
    expect(new PiJsonLines().push(Buffer.from('{"type":"agent_settled"}\r\n'))).toHaveLength(1);
    expect(() => new PiJsonLines().push(Buffer.from("not json\n"))).toThrow();
    expect(() => new PiJsonLines().push(Buffer.from("[]\n"))).toThrow();
    const pending = new PiJsonLines();
    pending.push(Buffer.from('{"type":'));
    expect(() => pending.finish()).toThrow("incomplete");
  });

  it("bounds pending frames", () => {
    expect(() => new PiJsonLines(10).push(Buffer.from("a".repeat(11)))).toThrow("byte limit");
  });

  it("drains events before surfacing a transport failure", async () => {
    const queue = new PiEventQueue();
    queue.push({ type: "message_end" });
    queue.end(new Error("transport died"));
    const iterator = queue[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "message_end" });
    await expect(iterator.next()).rejects.toThrow("transport died");
  });
});
