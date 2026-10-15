import type { StreamEvent, UsagePayload } from "@/shared/types";
import type { PiRecord } from "./protocol";
import { PiRuntimeError } from "./process";

type Part = { index: number; kind: "text" | "thinking"; content: string; ended: boolean };

/** Projects Pi contentIndex within each message onto monotonically allocated platform parts. */
export class PiEventProjection {
  private nextIndex = 0;
  private readonly parts = new Map<number, Part>();
  private inputTokens = 0;
  private outputTokens = 0;
  private hasUsage = false;
  private incompleteUsage = false;
  committedAssistantMessages = 0;

  constructor(private readonly conversationId: string, private readonly modelId: string) {}

  consume(record: PiRecord): StreamEvent[] {
    const events: StreamEvent[] = [];
    const message = object(record.message);
    if (record.type === "message_start" && message?.role === "assistant") {
      this.parts.clear();
    } else if (record.type === "message_update") {
      const delta = object(record.assistantMessageEvent);
      if (!delta || typeof delta.type !== "string") throw new PiRuntimeError("Pi sent an invalid message delta.", "protocol");
      const kind = delta.type.startsWith("thinking_") ? "thinking" : delta.type.startsWith("text_") ? "text" : null;
      if (!kind) return events;
      const index = delta.contentIndex;
      if (!Number.isInteger(index) || Number(index) < 0) throw new PiRuntimeError("Pi contentIndex is invalid.", "protocol");
      const part = this.part(Number(index), kind, events);
      if (delta.type.endsWith("_delta")) {
        if (typeof delta.delta !== "string" || part.ended) throw new PiRuntimeError("Pi sent a delta outside an active content block.", "protocol");
        part.content += delta.delta;
        events.push(this.event({ type: "part.delta", messageId: "", partIndex: part.index,
          delta: { type: kind === "text" ? "text.append" : "thinking.append", text: delta.delta } }));
      } else if (delta.type.endsWith("_end")) this.endPart(part, events);
    } else if (record.type === "message_end" && message?.role === "assistant") {
      if (!Array.isArray(message.content)) throw new PiRuntimeError("Pi committed an invalid assistant message.", "protocol");
      for (const [index, item] of message.content.entries()) {
        const block = object(item);
        const kind = block?.type === "text" ? "text" : block?.type === "thinking" ? "thinking" : null;
        if (!kind) continue;
        const content = block?.[kind];
        if (typeof content !== "string") throw new PiRuntimeError("Pi committed invalid text content.", "protocol");
        const part = this.part(index, kind, events);
        if (!content.startsWith(part.content)) throw new PiRuntimeError("Pi committed content differs from its streamed prefix.", "protocol");
        const remaining = content.slice(part.content.length);
        if (remaining && part.ended) throw new PiRuntimeError("Pi committed additional content after closing its block.", "protocol");
        if (remaining) events.push(this.event({ type: "part.delta", messageId: "", partIndex: part.index,
          delta: { type: kind === "text" ? "text.append" : "thinking.append", text: remaining } }));
        part.content = content;
        this.endPart(part, events);
      }
      this.committedAssistantMessages++;
      const usage = object(message.usage);
      if (usage && finiteCount(usage.input) && finiteCount(usage.output) &&
        usage.input + usage.output + (finiteCount(usage.cacheRead) ? usage.cacheRead : 0) + (finiteCount(usage.cacheWrite) ? usage.cacheWrite : 0) > 0) {
        this.hasUsage = true;
        this.inputTokens += usage.input + (finiteCount(usage.cacheRead) ? usage.cacheRead : 0) + (finiteCount(usage.cacheWrite) ? usage.cacheWrite : 0);
        this.outputTokens += usage.output;
      } else this.incompleteUsage = true;
      if (message.stopReason === "error") {
        const reason = typeof message.errorMessage === "string" ? message.errorMessage : "";
        if (/\b(?:401|403)\b|unauthorized|invalid.api.key|authentication/i.test(reason)) throw new PiRuntimeError("Pi model authentication failed. Check the selected provider and credentials.", "authentication");
        if (/\b429\b|rate.limit/i.test(reason)) throw new PiRuntimeError("Pi model rate limit was exceeded.", "rate_limit");
        throw new PiRuntimeError("Pi model request failed. Check the selected provider, model and credentials.", "provider");
      }
      if (message.stopReason === "length") throw new PiRuntimeError("Pi model output budget was exhausted before completing the response.", "output_limit");
      if (message.stopReason === "aborted") throw new PiRuntimeError("Pi aborted the active model turn.", "aborted");
    }
    return events;
  }

  usage(): UsagePayload | null {
    return this.hasUsage && !this.incompleteUsage ? { modelId: this.modelId, inputTokens: this.inputTokens, outputTokens: this.outputTokens } : null;
  }

  private part(contentIndex: number, kind: Part["kind"], events: StreamEvent[]): Part {
    const existing = this.parts.get(contentIndex);
    if (existing) {
      if (existing.kind !== kind) throw new PiRuntimeError("Pi reused a contentIndex for a different block type.", "protocol");
      return existing;
    }
    const part: Part = { index: this.nextIndex++, kind, content: "", ended: false };
    this.parts.set(contentIndex, part);
    events.push(this.event({ type: "part.start", messageId: "", partIndex: part.index, part: { type: kind, content: "" } }));
    return part;
  }

  private endPart(part: Part, events: StreamEvent[]): void {
    if (part.ended) return;
    part.ended = true;
    events.push(this.event({ type: "part.end", messageId: "", partIndex: part.index }));
  }

  private event<T extends object>(value: T): T & { conversationId: string; timestamp: number } {
    return { ...value, conversationId: this.conversationId, timestamp: Date.now() };
  }
}

function finiteCount(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
export function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
