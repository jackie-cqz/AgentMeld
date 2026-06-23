import { eventBus } from "@/server/event-bus";
import {
  createArtifact,
  getArtifact,
  updateMessageParts
} from "@/server/repositories";
import type { MessagePart, StreamEvent, UsagePayload } from "@/shared/types";

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

export type StreamUsage = UsagePayload;

export interface ConsumeStreamResult {
  parts: MessagePart[];
  usage: StreamUsage | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Unified stream consumer used by every adapter invocation path:
 *   - executeRun (non-conductor agent)
 *   - runConductorAssess (PLAN stage)
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
    const { parts: newParts, sideEvents } = applyPartsState(parts, filled);
    parts = newParts;
    if (flush) {
      updateMessageParts(input.messageId, parts, Date.now());
    }

    // 4. Broadcast main event + any synthetic side events (e.g. part.start for artifact_ref)
    eventBus.publish(filled);
    for (const side of sideEvents) {
      eventBus.publish(side);
    }

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
    case "deploy.status":
    case "run.usage":
      return true;
    default:
      return false;
  }
}

interface PartsResult {
  parts: MessagePart[];
  /** Side events to broadcast after the triggering event (e.g. part.start for artifact_ref) */
  sideEvents: StreamEvent[];
}

/**
 * Pure function: given current parts array and a stream event, returns the
 * new parts array plus any synthetic side events to broadcast.
 */
function applyPartsState(parts: MessagePart[], event: StreamEvent): PartsResult {
  const noSide: StreamEvent[] = [];

  switch (event.type) {
    case "part.start": {
      const next = [...parts];
      next[event.partIndex] = event.part as MessagePart;
      return { parts: next, sideEvents: noSide };
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
      return { parts: next, sideEvents: noSide };
    }

    case "tool.call": {
      const next = [...parts];
      next.push({
        type: "tool_use",
        callId: event.callId,
        toolName: event.toolName,
        args: event.args
      } as MessagePart);
      return { parts: next, sideEvents: noSide };
    }

    case "tool.result": {
      const next = [...parts];
      next.push({
        type: "tool_result",
        callId: event.callId,
        result: event.result,
        isError: event.isError
      } as MessagePart);
      return { parts: next, sideEvents: noSide };
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
      const sideEvents: StreamEvent[] = [];
      if (!next.some((p) => p.type === "artifact_ref" && p.artifactId === art.id)) {
        const refPart: MessagePart = {
          type: "artifact_ref",
          artifactId: art.id,
          title: art.title,
          artifactType: art.type
        };
        const refIndex = next.length;
        next.push(refPart);
        // P0.3: Emit synthetic part.start so live UI can render the artifact card
        sideEvents.push({
          type: "part.start",
          conversationId: event.conversationId,
          timestamp: event.timestamp,
          messageId: (event as { messageId?: string }).messageId ?? "",
          partIndex: refIndex,
          part: refPart
        } as StreamEvent);
      }
      return { parts: next, sideEvents };
    }

    case "deploy.status": {
      const next = [...parts];
      const existingIndex = next.findIndex(
        (p) => p.type === "deploy_status" && p.deployment.id === event.deployment.id
      );
      const deployPart: MessagePart = {
        type: "deploy_status",
        deployment: event.deployment
      };
      if (existingIndex >= 0) {
        next[existingIndex] = deployPart;
      } else {
        next.push(deployPart);
      }
      const partIndex = existingIndex >= 0 ? existingIndex : next.length - 1;
      return {
        parts: next,
        sideEvents: [{
          type: "part.start",
          conversationId: event.conversationId,
          timestamp: event.timestamp,
          messageId: event.messageId,
          partIndex,
          part: deployPart
        }]
      };
    }

    default:
      return { parts, sideEvents: noSide };
  }
}
