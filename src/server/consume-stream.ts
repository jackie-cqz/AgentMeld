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
  /** Parts already persisted for this message. Streamed part indices are appended
   *  after them instead of overwriting earlier stages' output (e.g. conductor assess → aggregate). */
  initialParts?: MessagePart[];
  /** Called for each event after filling IDs.
   *  Return `{ stop: true }` to persist/publish the current event, then break out of the loop. */
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
  let parts: MessagePart[] = input.initialParts ? [...input.initialParts] : [];
  // Maps the stream's own part index to the slot that part actually occupies in
  // the message. They are not the same number: tool parts are appended, so once a
  // tool call has been interleaved the stream index falls behind the array index.
  // Assigning `parts[event.partIndex]` directly would let a later text part
  // overwrite an already appended tool_use/tool_result part.
  const partSlots = new Map<number, number>();
  let usage: StreamUsage | null = null;

  for await (const event of input.stream) {
    if (input.signal?.aborted) break;

    // 1. Fill missing IDs, then resolve part indices to real message slots
    const filled = resolvePartIndex(fillEventIds(event, input.messageId, input.runId), partSlots, parts);

    // 2. Callback can inspect the event and request that no later events are consumed.
    // The current event is still persisted/published so tool results never disappear from the UI.
    let shouldStop = false;
    if (input.onEvent) {
      const decision = input.onEvent(filled);
      shouldStop = Boolean(decision?.stop);
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

    if (shouldStop) break;
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
 * Rewrite a part event so its `partIndex` is the slot the part actually occupies
 * in the message.
 *
 * The adapter numbers only the parts it streams (0, 1, 2, …), while tool parts are
 * appended to the array as they arrive. Taking the stream index as an array index
 * therefore collides with appended tool parts — a second text part after a tool
 * call used to overwrite that call's `tool_use`. The first time a stream index is
 * seen it is bound to the next free slot; later events for it reuse that slot.
 * Rewriting the published event keeps the client reducer's index bookkeeping in
 * step, and `initialParts` needs no separate offset because the first fresh slot
 * already sits after them.
 */
function resolvePartIndex(
  event: StreamEvent,
  partSlots: Map<number, number>,
  parts: MessagePart[]
): StreamEvent {
  if (event.type !== "part.start" && event.type !== "part.delta" && event.type !== "part.end") {
    return event;
  }

  if (event.type === "part.start") {
    const slot = partSlots.get(event.partIndex) ?? parts.length;
    partSlots.set(event.partIndex, slot);
    return { ...event, partIndex: slot };
  }

  // A delta/end for a part we never saw start: leave it alone so the existing
  // "no such part" guards downstream still drop it.
  const slot = partSlots.get(event.partIndex);
  return slot === undefined ? event : { ...event, partIndex: slot };
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
        args: event.args,
        argumentRepair: event.argumentRepair
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
