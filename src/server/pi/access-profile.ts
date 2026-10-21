import type { HarnessAccessMode } from "@/server/harness/types";
import { assertHarnessAccessProfile, CONVERSATION_TOOL_NAMES } from "@/server/harness/tool-surface";

/** Pi's name for the platform's neutral access mode (#25 P2). */
export type PiAccessMode = HarnessAccessMode;

/**
 * Pi's historical import site for the conversation-only access rule.
 *
 * The rule is a platform decision (which platform tools a context-only turn may
 * reach), so it lives in `src/server/harness/tool-surface.ts` and every driver
 * applies the same one. Re-exported here for Pi call sites and tests.
 */
export { CONVERSATION_TOOL_NAMES };

export function assertPiAccessProfile(mode: PiAccessMode | undefined, toolNames: readonly string[]): void {
  assertHarnessAccessProfile(mode, toolNames);
}
