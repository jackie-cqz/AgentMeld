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

  /** What this driver can truthfully do (#25 P1 capability matrix). */
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
   * `cancellation: { supported: true, mode: "signal" }`; this is not a bug to
   * paper over with an invented abort registry inside the driver.
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
 * The capability matrix (#25 P1).
 *
 * Every field answers a question the platform asks before it dispatches: can
 * this engine do the work an Agent's run needs, and can the platform still
 * verify it? A capability a driver cannot honestly provide is `false`, and the
 * run then fails through `assertHarnessSupports` before any work begins instead
 * of producing output nobody can verify. There is deliberately no field for a
 * capability the platform does not currently depend on.
 */
export interface HarnessCapabilities {
  /** The harness brings its own file and command tools (read/write/edit/bash/…). */
  nativeTools: boolean;

  /**
   * The harness can invoke the platform's business tools — `write_artifact`,
   * `deploy_*`, `report_task_result`, `ask_user` and the rest of the server-side
   * tool registry — not only its own native tools. Artifact delivery and
   * delegated task reporting both depend on this.
   */
  businessTools: boolean;

  /**
   * How a run can be cancelled. `"signal"`: the caller aborts the `AbortSignal`
   * it handed to `run`. `"run-id"`: `abort(runId)` also works. `mode` is `null`
   * when the harness cannot be cancelled at all.
   */
  cancellation: { supported: boolean; mode: "signal" | "run-id" | null };

  /**
   * Whether tool outcomes can be mapped into the platform evidence contract
   * (file hashes, command results, business-tool receipts). Without it a run may
   * still produce files, but delegated acceptance cannot be verified.
   */
  evidence: boolean;

  /**
   * `"platform"`: the harness consumes the context packet the platform compiles
   * (task identity, active facts, upstream artifacts, acceptance contract).
   * `"harness"`: it builds its own context, so that packet never reaches the model.
   */
  contextPacket: "platform" | "harness";

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
