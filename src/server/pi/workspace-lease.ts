import {
  acquireWorkspaceLease,
  type PlatformWorkspaceLease,
} from "@/server/harness/workspace-lease";

/**
 * Pi's adapter over the platform-owned workspace lease (#25 P2).
 *
 * The lifecycle — deterministic SQLite exclusion, release, poisoning and the
 * controlled consultation lend — is implemented once in
 * `src/server/harness/workspace-lease.ts` and handed to every driver through
 * `HarnessInvocationInput.workspaceLease`. This module only supplies Pi's name
 * for its own failure messages and keeps the historical entry point.
 */
export type PiWorkspaceLease = PlatformWorkspaceLease;

export async function acquirePiWorkspace(workspace: string, signal: AbortSignal): Promise<PiWorkspaceLease> {
  return acquireWorkspaceLease(workspace, signal, { ownerLabel: "Pi" });
}
