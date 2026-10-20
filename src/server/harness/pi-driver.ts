import { getPiDoctor } from "@/server/pi/config";
import { renderPiContextPacket } from "@/server/pi/packet";
import { runPiInvocation } from "@/server/pi/runtime";
import { PiRuntimeError } from "@/server/pi/process";
import type { PiInvocationInput } from "@/server/pi/types";
import type { PiWorkspaceLease } from "@/server/pi/workspace-lease";
import type { Agent } from "@/shared/types";
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
 * Pi can only use a lease it produced (its peer handoff has its own `lend`
 * operation). Refuse a foreign ownership token instead of silently acquiring a
 * second lease or, worse, pretending the handoff exists.
 */
function piWorkspaceLease(lease: HarnessWorkspaceLease | undefined): PiWorkspaceLease | undefined {
  if (!lease) return undefined;
  if (!("lend" in lease)) {
    throw new PiRuntimeError("The workspace handoff did not come from a Pi execution.", "workspace_ownership");
  }
  return lease as PiWorkspaceLease;
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

  run(input: HarnessInvocationInput, signal: AbortSignal): HarnessRunStream {
    return runPiInvocation(toPiInvocationInput(input), signal);
  },

  // Pi exposes no run-id abort (`src/server/pi/controls.ts` only carries
  // follow-ups). Cancelling a Pi run means aborting the signal passed to `run`,
  // which the platform's run owner already holds; there is nothing to invent.
  abort(): boolean {
    return false;
  },
};
