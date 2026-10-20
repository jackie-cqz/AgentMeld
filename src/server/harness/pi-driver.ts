import { getPiDoctor } from "@/server/pi/config";
import { runPiInvocation } from "@/server/pi/runtime";
import type {
  HarnessCapabilities,
  HarnessDoctor,
  HarnessDriver,
  HarnessInvocationInput,
  HarnessRunStream,
} from "./types";

/**
 * The Pi driver: a pass-through, not a reimplementation.
 *
 * `run` forwards both arguments to `runPiInvocation` untouched and returns its
 * generator directly. Returning the original generator (rather than yielding
 * through a wrapper) keeps error, cancellation and back-pressure semantics
 * identical to the pre-driver call sites.
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
      // Pi is given `buildPiTaskPacket(input)` once per invocation instead of
      // compiling its own task context.
      contextPacket: "platform",
      followUp: true,
      streaming: true,
    };
  },

  run(input: HarnessInvocationInput, signal: AbortSignal): HarnessRunStream {
    return runPiInvocation(input, signal);
  },

  // Pi exposes no run-id abort (`src/server/pi/controls.ts` only carries
  // follow-ups). Cancelling a Pi run means aborting the signal passed to `run`,
  // which the platform's run owner already holds; there is nothing to invent.
  abort(): boolean {
    return false;
  },
};
