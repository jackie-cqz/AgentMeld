import { setTimeout as delay } from "node:timers/promises";
import type { PiInvocationInput, PiInvocationStream } from "@/server/pi/types";

/** Lifecycle tests use this substitute; the production runtime never imports it. */
export async function* fixturePiInvocation(input: PiInvocationInput, signal: AbortSignal): PiInvocationStream {
  await delay(20, undefined, { signal });
  const classification = input.systemPrompt.startsWith("AGENTMELD_TURN_CLASSIFIER_V1");
  if (!classification) input.onTaskAccepted?.();
  const base = { conversationId: input.conversationId, timestamp: Date.now(), messageId: "", partIndex: 0 };
  yield { ...base, type: "part.start", part: { type: "text", content: "" } };
  yield { ...base, type: "part.delta", delta: { type: "text.append", text: classification
    ? JSON.stringify({ intent: "discussion", targetRunId: null, mode: "discussion", reason: "Lifecycle fixture discussion." })
    : "Pi lifecycle fixture response" } };
  yield { ...base, type: "part.end" };
  yield { type: "run.usage", conversationId: input.conversationId, timestamp: Date.now(), runId: input.runId, usage: { modelId: "fixture", inputTokens: 1, outputTokens: 1 } };
}

/** Drain fixture-owned runs before their test closes or replaces the database. */
export async function stopFixtureRuns(): Promise<void> {
  const { getDatabase } = await import("@/db/client");
  const { abortRun, isRunActive, waitForRunTreeStop } = await import("@/server/agent-runner");
  const runs = (getDatabase().prepare("SELECT id FROM agent_runs").all() as Array<{ id: string }>).filter(run => isRunActive(run.id));
  for (const run of runs) abortRun(run.id);
  const signal = AbortSignal.timeout(5000);
  for (const run of runs) await waitForRunTreeStop(run.id, signal);
}
