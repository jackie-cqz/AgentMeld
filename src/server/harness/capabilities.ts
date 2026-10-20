import type { AdapterName } from "@/shared/types";
import type { HarnessDriver, HarnessRequirements } from "./types";

// Requirements are part of the invocation contract (#25 P2); re-exported here so
// existing callers that check capabilities keep their import site.
export type { HarnessRequirements } from "./types";

/**
 * A run selected an engine that cannot do what the run needs.
 *
 * It carries a category so the run owner can record an honest failure instead of
 * flattening it to "runtime", and names the engine plus every missing capability
 * so the message tells the user what to change.
 */
export class HarnessCapabilityError extends Error {
  readonly category = "harness_capability";

  constructor(
    readonly harnessId: AdapterName,
    readonly missing: readonly string[],
  ) {
    super(
      `The "${harnessId}" execution engine cannot run this Agent: it does not support ${missing.join("; ")}. ` +
        "Nothing was executed. Choose an Agent configured with an execution engine that supports this work.",
    );
    this.name = "HarnessCapabilityError";
  }
}

/**
 * Fail before dispatch when a harness cannot honestly support the run.
 *
 * The check is deliberately optimistic about nothing: a capability is required
 * only when the caller says this run cannot work without it, and a driver is
 * believed only when it declares it. Pi satisfies every requirement it actually
 * meets today, so this changes nothing for a Pi run.
 */
export function assertHarnessSupports(driver: HarnessDriver, requirements: HarnessRequirements): void {
  const capabilities = driver.capabilities();
  const missing: string[] = [];

  if (requirements.nativeTools && !capabilities.nativeTools) missing.push("native file/command tools");
  if (requirements.businessTools && !capabilities.businessTools) {
    missing.push("platform business tools (write_artifact, deploy_*, report_task_result, ask_user)");
  }
  if (requirements.evidence && !capabilities.evidence) missing.push("mapping tool outcomes into the evidence ledger");
  if (requirements.cancellation && !capabilities.cancellation.supported) missing.push("cancellation");
  if (requirements.contextPacket === "platform" && capabilities.contextPacket !== "platform") {
    missing.push("consuming the platform context packet");
  }

  if (missing.length > 0) throw new HarnessCapabilityError(driver.id, missing);
}
