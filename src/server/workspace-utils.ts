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
 * Extracted so the two callers cannot drift, which is exactly what happened: the
 * artifact delivery claimed to use "the same guard as the file browser" and used
 * a purely lexical check instead. That check is defeated by a symlink — a path
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
export function resolveWorkspaceFileForRead(
  workspace: Workspace,
  targetPath: string
): { ok: true; realPath: string; size: number } | { ok: false; reason: string } {
  const root = workspace.mode === "local" && workspace.boundPath ? workspace.boundPath : workspace.rootPath;

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { ok: false, reason: "the workspace root is not accessible" };
  }

  let logical: string;
  try {
    logical = resolveSafePath(root, targetPath);
  } catch {
    return { ok: false, reason: "the path is not inside the workspace" };
  }

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(logical);
  } catch {
    return { ok: false, reason: "the file is no longer on disk" };
  }

  if (!isPathWithin(realTarget, realRoot)) {
    return { ok: false, reason: "the path escapes the workspace" };
  }

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
export const MAX_TEXT_CHARS = 50_000;
export const MAX_FILE_WRITE_BYTES = 100_000; // 100 KB
export const BASH_OUTPUT_CHARS = 10_000;
export const BASH_TIMEOUT_MS = 30_000;
