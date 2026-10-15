import { setTimeout as delay } from "node:timers/promises";
import type { PiInvocationInput, PiInvocationStream } from "@/server/pi/types";

/** Lifecycle tests use this substitute; the production runtime never imports it. */
export async function* fixturePiInvocation(input: PiInvocationInput, signal: AbortSignal): PiInvocationStream {
  await delay(20, undefined, { signal });
  const base = { conversationId: input.conversationId, timestamp: Date.now(), messageId: "", partIndex: 0 };
  yield { ...base, type: "part.start", part: { type: "text", content: "" } };
  yield { ...base, type: "part.delta", delta: { type: "text.append", text: "Pi lifecycle fixture response" } };
  yield { ...base, type: "part.end" };
  yield { type: "run.usage", conversationId: input.conversationId, timestamp: Date.now(), runId: input.runId, usage: { modelId: "fixture", inputTokens: 1, outputTokens: 1 } };
}
