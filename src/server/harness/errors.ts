/**
 * The neutral failure taxonomy at the harness seam (issue #25 P2).
 *
 * `agent_runs.error_category` is user/QA-visible: it is persisted, returned by
 * the runs API and read by recovery/settlement code. These strings are therefore
 * a contract, not an implementation detail, and every category below is one the
 * platform already persists today. A harness reports a *category*, never a
 * harness-specific exception type, so the run owner can stop importing Pi's
 * error class.
 *
 * Derivation: every category in this list is thrown at least once by the Pi
 * runtime, the Pi driver, the registry/capability checks, or the platform code
 * that now uses `HarnessError` (agent-runner, turn classifier/admission,
 * consultations, conductor, collaboration context). See
 * `src/server/harness/errors.test.ts` for the Pi→neutral mapping table.
 */
export const HARNESS_ERROR_CATEGORIES = [
  /** The human cancelled the run; distinct from an engine failure. */
  "aborted",
  /** Missing/invalid provider credential. */
  "authentication",
  /** A classifier turn could not produce a valid decision. */
  "classification",
  /** Teardown/ownership release could not be confirmed. Never treated as a clean abort. */
  "cleanup_failed",
  /** The Conductor contract (plan/aggregate) was not satisfied. */
  "conductor_contract",
  /** The invocation or engine configuration is invalid. */
  "configuration",
  /** The compiled context cannot fit the model window. */
  "context_overflow",
  /** A follow-up/control receipt could not be settled durably. */
  "control_receipt_failed",
  /** The run's control channel is gone. */
  "control_unavailable",
  /** The engine settled without a committed assistant turn. */
  "empty_response",
  /** The engine's required extension/bridge did not initialize. */
  "extension_unavailable",
  /** The selected engine cannot perform what the run needs (capability matrix). */
  "harness_capability",
  /** No engine is registered for the Agent's adapter. */
  "harness_unavailable",
  /** The Agent still names a retired engine and must be migrated. */
  "migration_required",
  /** Delegated work ended without its required task report. */
  "missing_task_report",
  /** The model output budget was exhausted. */
  "output_limit",
  /** The engine process exited or disconnected before settling. */
  "process_exit",
  /** The engine violated the invocation protocol. */
  "protocol",
  /** The provider request failed without a more specific category. */
  "provider",
  /** The provider rate limit was exceeded. */
  "rate_limit",
  /** The documented fallback for an unmapped engine category. */
  "runtime",
  /** A platform access rule refused the invocation. */
  "security_policy",
  /** The engine could not be started. */
  "startup",
  /** An engine/request deadline elapsed. */
  "timeout",
  /** A request could not be delivered to the engine. */
  "transport",
  /** The turn/tool budget supervision limit was reached. */
  "turn_limit",
  /** The installed engine version does not match the pinned version. */
  "version_mismatch",
  /** Workspace ownership was lost, foreign, or handed to the wrong workspace. */
  "workspace_ownership",
] as const;

export type HarnessErrorCategory = (typeof HARNESS_ERROR_CATEGORIES)[number];

/**
 * The fallback for an engine category the neutral taxonomy does not know.
 *
 * `runtime` is chosen because it is the string the platform already persists for
 * an otherwise-uncategorised engine failure (`src/server/pi/runtime.ts` and
 * `src/server/agent-runner.ts` both use it). It is *not* a silent `unknown`: the
 * raw engine category is preserved on `sourceCategory` for logs, and the failure
 * message is passed through unchanged.
 */
export const HARNESS_ERROR_FALLBACK: HarnessErrorCategory = "runtime";

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(HARNESS_ERROR_CATEGORIES);

export function isHarnessErrorCategory(value: string): value is HarnessErrorCategory {
  return KNOWN_CATEGORIES.has(value);
}

/**
 * A failure crossing the harness seam.
 *
 * The platform catches this type and persists `category` verbatim into
 * `agent_runs.error_category`. Everything below a driver may keep its own error
 * class; the driver is responsible for translating it exactly once.
 */
export class HarnessError extends Error {
  constructor(
    message: string,
    readonly category: HarnessErrorCategory,
    /**
     * The engine's original category when `category` is the documented fallback.
     * Kept for diagnostics only; it is never persisted as `error_category`.
     */
    readonly sourceCategory?: string,
  ) {
    super(message);
    this.name = "HarnessError";
  }
}

/**
 * Build a neutral error from an engine's own category string.
 *
 * A known category keeps the exact persisted string (zero behaviour change for
 * Pi). An unknown one degrades to `HARNESS_ERROR_FALLBACK` and records the raw
 * category on `sourceCategory` instead of pretending it was mapped.
 */
export function harnessErrorFromCategory(message: string, category: string): HarnessError {
  if (isHarnessErrorCategory(category)) return new HarnessError(message, category);
  return new HarnessError(message, HARNESS_ERROR_FALLBACK, category);
}
