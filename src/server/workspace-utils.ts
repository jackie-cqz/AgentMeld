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

export const SANDBOX_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
export const SANDBOX_MAX_FILES = 1000;

export interface WorkspaceUsage {
  totalBytes: number;
  totalFiles: number;
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
export const MAX_TEXT_CHARS = 50_000;
export const MAX_FILE_WRITE_BYTES = 100_000; // 100 KB
export const BASH_OUTPUT_CHARS = 10_000;
export const BASH_TIMEOUT_MS = 30_000;
