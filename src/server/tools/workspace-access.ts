import fs from "node:fs";
import path from "node:path";
import { assertRealPathWithinWorkspace, isPathWithin } from "@/server/workspace-utils";

export const SEARCH_EXCLUDES = ["**/node_modules/**", "**/.git/**", "**/.next/**", "**/dist/**", "**/build/**", "**/coverage/**", "**/.env*", "**/*.pem", "**/*.key", "**/.npmrc", "**/.netrc", "**/.pypirc", "**/.git-credentials", "**/.ssh/**", "**/.aws/**"];

/**
 * Resolve a path handed to a LIVE extension tool, with the capability decision
 * of issue #79: full access, exactly like a standalone Pi agent.
 *
 * A relative path resolves against the invocation root and an absolute path is
 * used as-is; a path that leaves the root is ADMITTED and resolved, never refused.
 * Pi-native read/write/edit are unconfined, so a platform extension tool must not
 * re-introduce a workspace gate through the path it was given. The realpath is
 * returned for an existing target so callers that compare it against a realpath
 * produced elsewhere (git, Chromium) keep agreeing; a target that does not exist
 * yet is returned as its resolved logical path.
 */
export function resolveToolPath(root: string, target: string): string {
  const resolved = path.resolve(root, target);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

/**
 * Resolve a path for the RETIRED platform fs_* handlers (fs_read, fs_search).
 *
 * Those handlers are unreachable from an Agent run: the Pi bridge serves the
 * whole filesystem family with Pi's native read/grep/find and never registers
 * these platform names as extension tools (issue #79 audit, `src/server/pi/bridge.ts`).
 * Containment and the credential filter stay here because nothing on the Agent
 * surface reaches this function; every live extension tool uses `resolveToolPath`.
 */
export function safeWorkspacePath(root: string, target: string): string {
  const candidate = assertRealPathWithinWorkspace(root, target);
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(candidate);
  if (!isPathWithin(real, realRoot)) throw new Error("Path escapes workspace through a symlink.");
  const parts = path.relative(realRoot, real).split(path.sep);
  if (parts.some(part => /^\.env(?!\.example$)|\.(?:pem|key)$|^\.(?:ssh|aws|npmrc|netrc|pypirc|git-credentials)$|^\.git$/i.test(part))) {
    throw new Error("Access to credential or repository-private files is blocked.");
  }
  return real;
}

export function toolProcessEnv(): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "LC_ALL", "APPDATA", "LOCALAPPDATA"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}
