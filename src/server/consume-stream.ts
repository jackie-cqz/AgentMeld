import { eventBus } from "@/server/event-bus";
import {
  createArtifact,
  getArtifact,
  updateMessageParts
} from "@/server/repositories";
import type { MessagePart, StreamEvent } from "@/shared/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsumeStreamInput {
  stream: AsyncIterable<StreamEvent>;
  messageId: string;
  runId: string;
  signal?: AbortSignal;
  /** Called for each event after filling IDs and before publishing.
   *  Return `{ stop: true }` to break out of the loop. */
  onEvent?: (event: StreamEvent) => { stop?: boolean } | void;
}

export interface StreamUsage {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ConsumeStreamResult {
  parts: MessagePart[];
  usage: StreamUsage | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Unified stream consumer used by every adapter invocation path:
 *   - executeRun (non-orchestrator agent)
 *   - runOrchestratorAssess (PLAN stage)
 *   - runAggregateStage (AGGREGATE stage)
 *
 * For each event:
 *   1. Fill missing messageId / runId
 *   2. Apply persistence side-effects (DB: parts, artifacts)
 *   3. Broadcast via EventBus → SSE → frontend
 *   4. Optional onEvent callback (e.g. plan_tasks interception)
 */
export async function consumeStream(
  input: ConsumeStreamInput
): Promise<ConsumeStreamResult> {
  let parts: MessagePart[] = [];
  let usage: StreamUsage | null = null;

  for await (const event of input.stream) {
    if (input.signal?.aborted) break;

    // 1. Fill missing IDs
    const filled = fillEventIds(event, input.messageId, input.runId);

    // 2. Callback FIRST — allows interception (e.g. plan_tasks) before any side effects
    if (input.onEvent) {
      const decision = input.onEvent(filled);
      if (decision?.stop) break; // Don't accumulate, don't publish
    }

    // 3. Persistence side-effects — accumulate parts + update DB at key events
    const flush = getFlushEvents(filled);
    parts = applyPartsState(parts, filled);
    if (flush) {
      updateMessageParts(input.messageId, parts, Date.now());
    }

    // 4. Broadcast
    eventBus.publish(filled);

    // 5. Track usage
    if (filled.type === "run.usage") {
      usage = filled.usage;
    }
  }

  // Final flush — ensure all accumulated parts are persisted
  updateMessageParts(input.messageId, parts, Date.now());

  return { parts, usage };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function fillEventIds(event: StreamEvent, messageId: string, runId: string): StreamEvent {
  let e = event;
  if ("messageId" in e && !(e as { messageId?: string }).messageId) {
    e = { ...e, messageId };
  }
  if ("runId" in e && !(e as { runId?: string }).runId) {
    e = { ...e, runId };
  }
  return e as StreamEvent;
}

/**
 * Returns true for event types that "finalize" a logical unit of content.
 * We flush to DB at these boundaries rather than on every delta (perf).
 */
function getFlushEvents(event: StreamEvent): boolean {
  switch (event.type) {
    case "part.end":
    case "tool.call":
    case "tool.result":
    case "artifact.create":
    case "run.usage":
      return true;
    default:
      return false;
  }
}

/**
 * Pure function: given current parts array and a stream event, returns the
 * new parts array. Same logic as the original applyEventToState but stateless
 * (no DB writes — caller handles that).
 */
function applyPartsState(parts: MessagePart[], event: StreamEvent): MessagePart[] {
  switch (event.type) {
    case "part.start": {
      const next = [...parts];
      next[event.partIndex] = event.part as MessagePart;
      return next;
    }

    case "part.delta": {
      const next = [...parts];
      const part = next[event.partIndex];
      if (part && (part.type === "text" || part.type === "thinking" || part.type === "code")) {
        next[event.partIndex] = {
          ...part,
          content: part.content + (event.delta as { text: string }).text
        } as MessagePart;
      }
      return next;
    }

    case "tool.call": {
      const next = [...parts];
      next.push({
        type: "tool_use",
        callId: event.callId,
        toolName: event.toolName,
        args: event.args
      } as MessagePart);
      return next;
    }

    case "tool.result": {
      const next = [...parts];
      next.push({
        type: "tool_result",
        callId: event.callId,
        result: event.result,
        isError: event.isError
      } as MessagePart);
      return next;
    }

    case "artifact.create": {
      const art = event.artifact;
      // Only persist artifact if not already created (avoids duplicate insert G3)
      const existing = getArtifact(art.id);
      if (!existing) {
        createArtifact({
          id: art.id,
          conversationId: art.conversationId,
          createdByAgentId: art.createdByAgentId,
          type: art.type,
          title: art.title,
          content: art.content,
          version: art.version,
          parentArtifactId: art.parentArtifactId,
          now: art.createdAt
        });
      }
      // Inject artifact_ref part (idempotent by artifactId)
      const next = [...parts];
      if (!next.some((p) => p.type === "artifact_ref" && p.artifactId === art.id)) {
        next.push({
          type: "artifact_ref",
          artifactId: art.id,
          title: art.title,
          artifactType: art.type
        } as MessagePart);
      }
      return next;
    }

    default:
      return parts;
  }
}
