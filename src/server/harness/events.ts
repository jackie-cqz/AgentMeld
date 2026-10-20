import type { Artifact, DeployStatusRecord, StreamEvent, UsagePayload } from "@/shared/types";
import { HarnessError } from "./errors";

/**
 * The neutral event vocabulary at the harness seam (issue #25 P2).
 *
 * A driver reports what its engine did; it does not emit the platform's
 * `StreamEvent` wire shape. In particular there is no `messageId`, `partIndex`
 * slot, `runId`, Pi `contentIndex`, `StreamEvent` discriminant or Pi projection
 * state in these events — the platform owns those when it projects.
 *
 * The union covers exactly what the platform currently needs to persist or
 * publish:
 *
 * - lifecycle: `run.started`, `run.stage`, `run.settled`
 * - assistant output: `output.start`, `output.delta`, `output.end` (`text` or
 *   `thinking` blocks, with a driver-chosen `blockIndex`)
 * - tool activity: `tool.call`, `tool.result`
 * - platform-side effects produced by tool outcomes: `artifact.created`,
 *   `deployment.status`
 * - usage: `run.usage`
 *
 * Every event belongs to the one invocation that produced the stream, so there
 * is no `conversationId`/`timestamp` envelope here: the platform stamps those
 * when projecting. Terminal/status state is still owned by the run owner; the
 * driver's `run.settled` is an explicit report, not a second state machine.
 *
 * Deliberately absent, because no engine can honestly report them through this
 * seam and they remain Pi-side:
 *
 * - Pi's `heartbeat`, `run.start`/`run.end`, `message.start`/`message.end`,
 *   `dispatch.*` and `collaboration.*` records. Those are platform-originated
 *   (the run owner and event bus publish them), not engine output.
 * - Pi's `contentIndex` (the Pi projection maps it internally) and Pi's
 *   `message_start`/`message_end`/`agent_settled` records. They drive Pi's
 *   process/projection bookkeeping (`src/server/pi/events.ts`,
 *   `src/server/pi/runtime.ts`) and never cross the seam as events.
 * - The context-captured receipt: it is a platform callback
 *   (`onContextCaptured`), not an event today, so it stays on
 *   `HarnessInvocationInput`.
 */
export type HarnessEvent =
  /** The engine accepted the invocation and began executing it. */
  | { type: "run.started" }
  /**
   * A lifecycle stage change. Pi reports its stages through the platform
   * `onStage` callback today, so the Pi driver emits no `run.stage`; the member
   * exists for engines that report lifecycle in-band. The platform keeps stage
   * publication on the callback to avoid double-publishing.
   */
  | { type: "run.stage"; stage: HarnessRunStage }
  /** A new streamed output block. `blockIndex` is unique until `output.end`. */
  | { type: "output.start"; blockIndex: number; kind: HarnessOutputKind; content?: string }
  /** Incremental content for an open output block. */
  | { type: "output.delta"; blockIndex: number; kind: HarnessOutputKind; text: string }
  /** The output block is complete; no further deltas for this `blockIndex`. */
  | { type: "output.end"; blockIndex: number }
  /** A tool call began. `args` are whatever the engine parsed/received. */
  | { type: "tool.call"; callId: string; toolName: string; args: unknown }
  /** A tool call finished. `isError` is required: "unknown" is not a success. */
  | { type: "tool.result"; callId: string; result: unknown; isError: boolean }
  /** A platform artifact was created as a result of the invocation. */
  | { type: "artifact.created"; artifact: Artifact }
  /** A deployment status changed as a result of the invocation. */
  | { type: "deployment.status"; deployment: DeployStatusRecord }
  /** Provider/model usage for the invocation, when the engine reports it. */
  | { type: "run.usage"; usage: UsagePayload }
  /**
   * The engine reached a terminal state. `completed` means it settled
   * successfully; `failed`/`aborted` carry the human-readable reason the
   * platform should surface. A driver that throws a `HarnessError` still yields
   * this event first, so stream consumers see one explicit terminal event.
   */
  | { type: "run.settled"; status: HarnessSettledStatus; reason?: string };

export type HarnessRunStage = "queued" | "running";
export type HarnessOutputKind = "text" | "thinking";
export type HarnessSettledStatus = "completed" | "failed" | "aborted";

/**
 * Project a neutral harness stream onto the platform's persisted `StreamEvent`
 * vocabulary.
 *
 * This is the only place that turns driver output into today's wire/persistence
 * shapes, so a second driver never has to synthesize `messageId: ""`,
 * `partIndex` slots or Pi's `text.append`/`thinking.append` delta names.
 *
 * Mapping (one neutral event → zero or one `StreamEvent`):
 *
 * | neutral | platform |
 * | --- | --- |
 * | `run.started` / `run.stage` / `run.settled` | — (lifecycle is platform-owned) |
 * | `output.start` | `part.start` with the next platform part index |
 * | `output.delta` | `part.delta` (`text.append` / `thinking.append`) |
 * | `output.end` | `part.end` |
 * | `tool.call` | `tool.call` |
 * | `tool.result` | `tool.result` |
 * | `artifact.created` | `artifact.create` |
 * | `deployment.status` | `deploy.status` |
 * | `run.usage` | `run.usage` |
 *
 * `consumeStream` still fills `messageId`/`runId`; the projected events carry
 * the same empty IDs the Pi runtime used to emit.
 */
export async function* projectHarnessStream(
  stream: AsyncIterable<HarnessEvent>,
  conversationId: string
): AsyncGenerator<StreamEvent> {
  const blocks = new Map<number, { partIndex: number; kind: HarnessOutputKind }>();
  let nextPartIndex = 0;

  for await (const event of stream) {
    switch (event.type) {
      case "run.started":
      case "run.stage":
      case "run.settled":
        continue;

      case "output.start": {
        if (blocks.has(event.blockIndex)) {
          throw new HarnessError("The harness started an output block that was already open.", "protocol");
        }
        const partIndex = nextPartIndex++;
        blocks.set(event.blockIndex, { partIndex, kind: event.kind });
        yield {
          type: "part.start",
          conversationId,
          timestamp: Date.now(),
          messageId: "",
          partIndex,
          part: { type: event.kind, content: event.content ?? "" },
        };
        continue;
      }

      case "output.delta": {
        const block = blocks.get(event.blockIndex);
        if (!block) throw new HarnessError("The harness streamed output for a block it never started.", "protocol");
        if (block.kind !== event.kind) throw new HarnessError("The harness changed an output block's kind mid-stream.", "protocol");
        yield {
          type: "part.delta",
          conversationId,
          timestamp: Date.now(),
          messageId: "",
          partIndex: block.partIndex,
          delta: { type: event.kind === "text" ? "text.append" : "thinking.append", text: event.text },
        };
        continue;
      }

      case "output.end": {
        const block = blocks.get(event.blockIndex);
        if (!block) throw new HarnessError("The harness ended an output block it never started.", "protocol");
        blocks.delete(event.blockIndex);
        yield { type: "part.end", conversationId, timestamp: Date.now(), messageId: "", partIndex: block.partIndex };
        continue;
      }

      case "tool.call":
        yield {
          type: "tool.call",
          conversationId,
          timestamp: Date.now(),
          messageId: "",
          callId: event.callId,
          toolName: event.toolName,
          args: event.args,
        };
        continue;

      case "tool.result":
        yield {
          type: "tool.result",
          conversationId,
          timestamp: Date.now(),
          messageId: "",
          callId: event.callId,
          result: event.result,
          isError: event.isError,
        };
        continue;

      case "artifact.created":
        yield { type: "artifact.create", conversationId, timestamp: Date.now(), artifact: event.artifact };
        continue;

      case "deployment.status":
        yield { type: "deploy.status", conversationId, timestamp: Date.now(), messageId: "", deployment: event.deployment };
        continue;

      case "run.usage":
        yield { type: "run.usage", conversationId, timestamp: Date.now(), runId: "", usage: event.usage };
        continue;
    }
  }
}
