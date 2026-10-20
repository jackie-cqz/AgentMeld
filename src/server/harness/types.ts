import type { AdapterName } from "@/shared/types";
import type { PiInvocationInput, PiInvocationStream } from "@/server/pi/types";

/**
 * The seam between the platform and an execution engine (issue #25, P0).
 *
 * Pi is the only driver, so this interface is deliberately shaped around what
 * `runPiInvocation` already needs and returns. It names the seam and adds
 * nothing: no provider/model resolution, no tool bridge, no workspace leasing,
 * no event vocabulary of its own. Those remain Pi-owned and are the work of the
 * P1 capability matrix, not of P0.
 *
 * A second harness must satisfy this contract without the platform learning
 * about its internals; anything a driver cannot honestly support must be
 * reported here rather than emulated.
 */
export interface HarnessDriver {
  /** The legacy `AdapterName` value stored on Agent rows that selects this driver. */
  readonly id: AdapterName;

  /**
   * Whether this harness can run on this machine, with a human-readable reason
   * when it cannot. Must not throw for a missing/broken installation.
   */
  doctor(): HarnessDoctor;

  /** What this driver can truthfully do; the seed of #25 P1, not the matrix. */
  capabilities(): HarnessCapabilities;

  /**
   * Start exactly one invocation and return its lazily-consumed event stream.
   *
   * The invocation contract is currently Pi's: provider/model resolution,
   * tool admission and workspace ownership are captured from the input, and
   * cancellation is delivered through `signal`. A driver must not resolve
   * credentials earlier than it needs them.
   */
  run(input: HarnessInvocationInput, signal: AbortSignal): HarnessRunStream;

  /**
   * Request cancellation of an in-flight run by platform run id, returning
   * whether this driver performed one.
   *
   * Pi has no run-id abort entry point: the only cancellation channel it
   * exposes is the AbortSignal handed to `run`, which the platform owns. The Pi
   * driver therefore reports `false` and advertises
   * `cancellationMode: "signal"`; this is not a bug to paper over with an
   * invented abort registry inside the driver.
   */
  abort(runId: string): boolean;
}

/** Small and honest: only what a caller needs to decide whether to dispatch. */
export interface HarnessDoctor {
  available: boolean;
  version?: string;
  detail?: string;
}

/**
 * Seed capability matrix (expanded in #25 P1).
 *
 * `tools` describes how a run receives tools: `"native"` = only the harness's
 * own tools, `"business"` = only platform tools, `"native+business"` = both.
 * `cancellation` says whether a run can be cancelled at all, and
 * `cancellationMode` names the only supported channel: `"signal"` (the caller
 * aborts the signal it passed to `run`) or `"run-id"` (`abort(runId)` works).
 */
export interface HarnessCapabilities {
  tools: "native" | "native+business" | "business";
  cancellation: boolean;
  cancellationMode?: "signal" | "run-id";
  /** Whether the harness accepts live steering/follow-ups mid-run. */
  followUp: boolean;
  /** Whether output is incremental (`StreamEvent`s) rather than a final blob. */
  streaming: boolean;
}

/**
 * P0 keeps Pi's invocation shape as *the* harness input contract. Generalizing
 * it — streaming a harness-neutral context packet — belongs to P1.
 */
export type HarnessInvocationInput = PiInvocationInput;

/** P0 keeps Pi's event stream shape as the harness output contract. */
export type HarnessRunStream = PiInvocationStream;
