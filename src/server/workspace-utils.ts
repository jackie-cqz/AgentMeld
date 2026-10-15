import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "@/shared/types";

export function getEffectiveCwd(workspace: Workspace): string {
  if (workspace.mode === "local" && workspace.boundPath) {
    return workspace.boundPath;
  }
  return workspace.rootPath;
}

export function isPathWithin(child: string, parent: string): boolean {
  const normalizedChild = normalizePathForCompare(child);
  const normalizedParent = normalizePathForCompare(parent);
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(normalizedParent + path.sep)
  );
}

function normalizePathForCompare(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function resolveSafePath(workspacePath: string, targetPath: string): string {
  const resolved = path.resolve(workspacePath, targetPath);
  if (!isPathWithin(resolved, workspacePath)) {
    throw new Error(`Path "${targetPath}" is outside workspace.`);
  }
  return resolved;
}

export function assertPathWithinWorkspace(workspacePath: string, targetPath: string): string {
  return resolveSafePath(workspacePath, targetPath);
}

export const SANDBOX_MAX_BYTES = 1024 * 1024 * 1024; // 1 GB
export const SANDBOX_MAX_FILES = 50_000;

export interface WorkspaceUsage {
  totalBytes: number;
  totalFiles: number;
}

export interface SandboxQuotaLimits {
  maxBytes: number;
  maxFiles: number;
}

export function checkSandboxQuota(
  usage: WorkspaceUsage,
  nextFileBytes: number,
  replacedFileBytes = 0,
  createsNewFile = true,
  limits: SandboxQuotaLimits = {
    maxBytes: SANDBOX_MAX_BYTES,
    maxFiles: SANDBOX_MAX_FILES
  }
): string | null {
  if (usage.totalBytes - replacedFileBytes + nextFileBytes > limits.maxBytes) {
    return `Workspace quota exceeded: ${usage.totalBytes} bytes used, max ${limits.maxBytes}.`;
  }
  if (createsNewFile && usage.totalFiles >= limits.maxFiles) {
    return `Workspace file limit exceeded: ${usage.totalFiles} files, max ${limits.maxFiles}.`;
  }
  return null;
}

export function scanWorkspaceUsage(rootPath: string): WorkspaceUsage {
  const seen = new Set<string>();
  let totalBytes = 0;
  let totalFiles = 0;

  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let realPath: string;
    try {
      realPath = fs.realpathSync(current);
    } catch {
      continue;
    }
    if (seen.has(realPath)) continue;
    seen.add(realPath);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        totalFiles += 1;
        try {
          totalBytes += fs.statSync(fullPath).size;
        } catch {
          // File may have been deleted between readdir and stat.
        }
      }
    }
  }

  return { totalBytes, totalFiles };
}

export function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export const MAX_FILE_READ_BYTES = 1_048_576; // 1 MB

/**
 * Resolve a workspace-relative path for READING, the way the file browser does.
 *
 * Shared with the file browser, which used to keep its own copy of these steps.
 * The two are not identical in what they ACCEPT — the browser rejects an
 * absolute path inside the workspace that this one resolves, because it
 * pre-filters the path format — so the honest description is that they share
 * the resolution and the browser is the stricter of the two. What they must not
 * share is a difference in what they REFUSE, and a symlink leaving the
 * workspace is refused by both. That check is defeated by a symlink — a path
 * inside the workspace whose target is not — and the target's contents are then
 * read and sent wherever the caller sends things.
 *
 * The rules, in order, and each of them matters:
 *
 * 1. The root is the workspace's EFFECTIVE root. A local workspace reads from
 *    its bound directory; using the sandbox root instead would read a different
 *    file that happens to share the name.
 * 2. The root is resolved through `realpath`, so a symlinked root is compared as
 *    what it actually points at.
 * 3. The target is resolved through `realpath` TOO, and compared after that.
 *    This is the one that stops symlinks escaping — the lexical check passes a
 *    link that points anywhere.
 * 4. It must be a regular file: a directory, a FIFO or a device is not something
 *    to read, and a FIFO would block forever.
 */
export function resolveWorkspaceRealPath(
  workspace: Workspace,
  targetPath: string
): { ok: true; realPath: string; rootPath: string } | { ok: false; reason: string; code: string } {
  const root = workspace.mode === "local" && workspace.boundPath ? workspace.boundPath : workspace.rootPath;

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { ok: false, reason: "the workspace root is not accessible", code: "root" };
  }

  let logical: string;
  try {
    logical = resolveSafePath(root, targetPath);
  } catch {
    return { ok: false, reason: "the path is not inside the workspace", code: "malformed" };
  }

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(logical);
  } catch {
    return { ok: false, reason: "the file is no longer on disk", code: "missing" };
  }

  // After realpath, not before: a symlink passes a lexical check while pointing
  // anywhere, and its target is what would be read.
  if (!isPathWithin(realTarget, realRoot)) {
    return { ok: false, reason: "the path escapes the workspace", code: "escape" };
  }

  return { ok: true, realPath: realTarget, rootPath: realRoot };
}

export function resolveWorkspaceFileForRead(
  workspace: Workspace,
  targetPath: string
): { ok: true; realPath: string; size: number } | { ok: false; reason: string } {
  const resolved = resolveWorkspaceRealPath(workspace, targetPath);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const realTarget = resolved.realPath;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realTarget);
  } catch {
    return { ok: false, reason: "the file is no longer on disk" };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: "that is not a regular file" };
  }

  return { ok: true, realPath: realTarget, size: stat.size };
}
/**
 * The guard the fs_* TOOLS use: realpath-verified containment for a path that
 * may not exist yet.
 *
 * `assertPathWithinWorkspace` is lexical — `resolveSafePath` plus `startsWith`
 * — and the comment above `resolveWorkspaceRealPath` says plainly that such a
 * check "is defeated by a symlink". The tools were all still using the lexical
 * one, so a link inside the workspace pointing at /etc/passwd was read, and a
 * link pointing at a host file was written through. This is the same rule the
 * file browser already applies, extended to paths that do not exist yet:
 *
 * - the workspace root is compared as its realpath;
 * - an EXISTING target must resolve inside it, so a symlink out is refused;
 * - a target that does not exist is judged by its nearest existing ancestor's
 *   realpath — that is what a create would land in, so a symlinked-out parent
 *   is refused before the file is made.
 *
 * Returns the LOGICAL path (never the realpath: callers and the paths they
 * record work in workspace terms, and realpathing a temp directory rewrites its
 * prefix on some platforms) or throws the way `assertPathWithinWorkspace` does,
 * so tool call sites read the same.
 */
export function assertRealPathWithinWorkspace(workspacePath: string, targetPath: string): string {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(workspacePath);
  } catch {
    throw new Error("The workspace directory is not accessible.");
  }

  const logical = resolveSafePath(workspacePath, targetPath);

  // A DANGLING symlink is the case `existsSync` hides: it follows the link, so
  // a link whose target does not exist reads as "not created yet" and would be
  // judged by its ancestor — while a write to it follows the link and creates
  // the file wherever it points. Where it points cannot be verified, so it is
  // refused rather than guessed at.
  let danglingLink = false;
  try {
    danglingLink = fs.lstatSync(logical).isSymbolicLink() && !fs.existsSync(logical);
  } catch {
    // lstat failing means the path truly does not exist; the ancestor rule below
    // is the right one for that.
  }
  if (danglingLink) {
    // Not "escapes": this link may well point inside. What is missing is the
    // ability to VERIFY it — a chain of dangling links cannot be resolved — and
    // a refusal should say what it actually knows.
    throw new Error(`Cannot verify where this dangling symlink points: ${targetPath}`);
  }

  // Existing target: its realpath is what would be opened, so that is what
  // decides. The LOGICAL path is returned either way — callers (and the paths
  // they record) work in workspace terms, and realpathing a temp directory on
  // some platforms rewrites its prefix.
  if (fs.existsSync(logical)) {
    const realTarget = fs.realpathSync(logical);
    if (!isPathWithin(realTarget, realRoot)) {
      throw new Error(`Path escapes the workspace: ${targetPath}`);
    }
    return logical;
  }

  // Not created yet: the nearest existing ancestor decides where it would land.
  let ancestor = path.dirname(logical);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const realAncestor = fs.realpathSync(ancestor);
  if (!isPathWithin(realAncestor, realRoot)) {
    throw new Error(`Path escapes the workspace: ${targetPath}`);
  }
  return logical;
}

export const MAX_TEXT_CHARS = 50_000;
export const MAX_FILE_WRITE_BYTES = 100_000; // 100 KB
export const BASH_OUTPUT_CHARS = 10_000;
export const BASH_TIMEOUT_MS = 30_000;
