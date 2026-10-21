/**
 * Pi's historical import site for the platform tool surface.
 *
 * The surface itself is platform-owned now (#25 P2): `src/server/harness/
 * tool-surface.ts` decides which platform tools an invocation is provisioned
 * with, and every driver reads that same list. This module stays only so Pi-side
 * call sites and tests keep a stable path.
 */
export {
  CONVERSATION_ROSTER_TOOL,
  assertHarnessAccessProfile,
  provisionedPlatformToolNames,
} from "@/server/harness/tool-surface";
