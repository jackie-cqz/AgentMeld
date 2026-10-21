import { getPiDoctor } from "@/server/pi/config";
import { renderPiContextPacket } from "@/server/pi/packet";
import { runPiInvocation } from "@/server/pi/runtime";
import { PiRuntimeError } from "@/server/pi/process";
import type { PiInvocationInput } from "@/server/pi/types";
import type { PiWorkspaceLease } from "@/server/pi/workspace-lease";
import { isPlatformWorkspaceLease } from "./workspace-lease";
import type { Agent, StreamEvent } from "@/shared/types";
import { HarnessError, harnessErrorFromCategory } from "./errors";
import type { HarnessEvent, HarnessOutputKind } from "./events";
import type {
  HarnessAccessMode,
  HarnessCapabilities,
  HarnessDoctor,
  HarnessDriver,
  HarnessInvocationInput,
  HarnessRunStream,
  HarnessWorkspaceLease,
} from "./types";

/**
 * Convert the platform's neutral invocation into Pi's internal input.
 *
 * This is the only place that knows Pi's field names. The neutral contract
 * carries the platform packet; Pi renders it into its prompt envelope, and the
 * neutral provider target becomes Pi's provider snapshot fields. The resolved
 * target is also authoritative for the model/provider Pi config sees, so a stale
 * Agent object cannot redirect a run the platform already resolved.
 */
export function toPiInvocationInput(input: HarnessInvocationInput): PiInvocationInput {
  return {
    conversationId: input.conversationId,
    runId: input.runId,
    parentRunId: input.parentRunId,
    taskExecution: input.taskExecution,
    taskContract: input.taskContract,
    agent: {
      ...input.agent,
      modelProvider: input.provider.providerId as Agent["modelProvider"],
      modelId: input.provider.modelId,
    },
    conversation: input.conversation,
    workspace: input.workspace,
    triggerMessage: input.triggerMessage,
    recentMessages: input.context.recentMessages,
    toolNames: input.tools.names,
    systemPrompt: input.context.systemPrompt,
    workspacePath: input.workspaceRoot,
    history: input.context.packet.priorHistory,
    // The platform decided what context to send; Pi only renders the envelope.
    prompt: renderPiContextPacket(input.context.packet),
    apiKey: input.provider.credential,
    apiBaseUrl: input.provider.endpoint,
    providerRevision: input.provider.revision,
    catalogProvider: input.provider.catalogProvider,
    // The Agent's model-shaping choices are part of the resolved target, so Pi
    // reads them from the target rather than from a stale Agent snapshot.
    contextWindow: input.provider.contextWindow,
    reasoningEffort: input.provider.reasoningEffort,
    supportsVision: input.provider.vision,
    accessMode: input.access,
    workspaceLease: piWorkspaceLease(input.workspaceLease),
    maxTurns: input.maxTurns,
    timeoutMs: input.timeoutMs,
    onTaskAccepted: input.onTaskAccepted,
    onStage: input.onStage,
    onContextCaptured: input.onContextCaptured
      ? receipt => input.onContextCaptured?.({
          prompt: receipt.packet,
          systemPromptHash: receipt.systemPromptHash,
          toolNames: receipt.toolNames,
          access: receipt.accessMode as HarnessAccessMode,
        })
      : undefined,
  };
}

/**
 * Pi can only use workspace ownership the platform manager issued, because the
 * platform's tool bridge performs the consultation lend. This is no longer a
 * "Pi-only" check: a lease acquired by any engine through
 * `acquireWorkspaceLease` is accepted, and only a hand-rolled object that never
 * came from the platform is refused instead of silently acquiring a second
 * lease or pretending the handoff exists.
 */
function piWorkspaceLease(lease: HarnessWorkspaceLease | undefined): PiWorkspaceLease | undefined {
  if (!lease) return undefined;
  if (!isPlatformWorkspaceLease(lease)) {
    throw new HarnessError("The workspace handoff was not issued by the platform workspace lease manager.", "workspace_ownership");
  }
  return lease;
}

/**
 * Map one Pi projection event onto the neutral event vocabulary.
 *
 * This is the only Pi→neutral translation. Pi may only emit the subset below
 * from `runPiInvocation`; the rest of `StreamEvent` (`run.start`, `message.*`,
 * `dispatch.*`, …) is platform-originated and never reaches this function.
 * `contentIndex` never crosses the seam: Pi's projection already allocated a
 * monotonically increasing `partIndex`, which becomes the neutral
 * `blockIndex` (unique per run), so the platform can project the same blocks.
 */
export function toHarnessEvent(event: StreamEvent): HarnessEvent {
  switch (event.type) {
    case "part.start": {
      if (event.part.type !== "text" && event.part.type !== "thinking") {
        throw new HarnessError(`Pi emitted a "${event.part.type}" part, which is not assistant output.`, "protocol");
      }
      const kind: HarnessOutputKind = event.part.type;
      return { type: "output.start", blockIndex: event.partIndex, kind, content: event.part.content };
    }
    case "part.delta": {
      if (event.delta.type === "text.append") {
        return { type: "output.delta", blockIndex: event.partIndex, kind: "text", text: event.delta.text };
      }
      if (event.delta.type === "thinking.append") {
        return { type: "output.delta", blockIndex: event.partIndex, kind: "thinking", text: event.delta.text };
      }
      throw new HarnessError("Pi emitted an output delta the harness contract cannot carry.", "protocol");
    }
    case "part.end":
      return { type: "output.end", blockIndex: event.partIndex };
    case "tool.call":
      return { type: "tool.call", callId: event.callId, toolName: event.toolName, args: event.args };
    case "tool.result":
      return { type: "tool.result", callId: event.callId, result: event.result, isError: event.isError === true };
    case "artifact.create":
      return { type: "artifact.created", artifact: event.artifact };
    case "deploy.status":
      return { type: "deployment.status", deployment: event.deployment };
    case "run.usage":
      return { type: "run.usage", usage: event.usage };
    default:
      // Pi's runtime never yields these; a second Pi event kind must be added to
      // the neutral contract deliberately rather than silently dropped.
      throw new HarnessError(`Pi emitted "${event.type}", which the harness event contract does not carry.`, "protocol");
  }
}

/** Translate Pi's failure category into the neutral taxonomy exactly once. */
export function toHarnessError(error: PiRuntimeError): HarnessError {
  return harnessErrorFromCategory(error.message, error.category);
}

/**
 * An aborted signal is not always an aborted run: unconfirmed teardown is a
 * failure, which is the same distinction the run owner's `wasCancelled` makes.
 */
function settledAbortStatus(error: unknown, signal: AbortSignal): "aborted" | "failed" {
  if (!signal.aborted) return "failed";
  return error instanceof HarnessError && error.category === "cleanup_failed" ? "failed" : "aborted";
}

/**
 * The Pi driver: a translation layer, not a reimplementation.
 *
 * `run` maps the neutral input and forwards it to `runPiInvocation`. Everything
 * below the mapping — provider configuration, the packet envelope, tool bridge,
 * cancellation — remains Pi's, unchanged from the pre-driver call sites.
 */
export const piHarnessDriver: HarnessDriver = {
  id: "pi",

  doctor(): HarnessDoctor {
    const report = getPiDoctor();
    return {
      available: report.available,
      version: report.installedVersion ?? undefined,
      // A failure reason is the only detail a caller can act on; otherwise say
      // which pinned version and Node.js runtime the check accepted.
      detail: report.error ?? `Pi ${report.expectedVersion} on Node.js ${report.nodeVersion}.`,
    };
  },

  capabilities(): HarnessCapabilities {
    return {
      // Pi's own native toolset (read/write/edit/bash/…) is registered by its
      // extension; platform business tools reach it through the bridge
      // (`src/server/pi/bridge.ts`, `extension.mjs`).
      nativeTools: true,
      businessTools: true,
      // Cancellable, but only through the AbortSignal supplied to `run`.
      cancellation: { supported: true, mode: "signal" },
      // Native outcomes are hashed and recorded in `native-tools.ts`; business
      // tool receipts go through `captureEvidence` / `dispatch-tool-evidence`.
      evidence: true,
      // Pi is given the platform-compiled packet once per invocation instead of
      // compiling its own task context.
      contextPacket: "platform",
      followUp: true,
      streaming: true,
    };
  },

  async *run(input: HarnessInvocationInput, signal: AbortSignal): HarnessRunStream {
    yield { type: "run.started" };
    try {
      for await (const event of runPiInvocation(toPiInvocationInput(input), signal)) {
        yield toHarnessEvent(event);
      }
    } catch (error) {
      // Wrap Pi's exception exactly once, then still report a terminal event so
      // the stream is explicit about how the invocation ended. The error itself
      // is rethrown: the run owner has always treated a throw (not absence of
      // events) as the failure signal, and that stays byte-identical.
      const failure = error instanceof PiRuntimeError ? toHarnessError(error) : error;
      yield {
        type: "run.settled",
        status: settledAbortStatus(failure, signal),
        reason: failure instanceof Error ? failure.message : undefined,
      };
      throw failure;
    }
    yield { type: "run.settled", status: "completed" };
  },

  // Pi exposes no run-id abort (`src/server/pi/controls.ts` only carries
  // follow-ups). Cancelling a Pi run means aborting the signal passed to `run`,
  // which the platform's run owner already holds; there is nothing to invent.
  abort(): boolean {
    return false;
  },
};
