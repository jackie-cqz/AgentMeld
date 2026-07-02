// ---------------------------------------------------------------------------
// P1: Evidence content hashing — sha256 for files, artifacts, command output
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function hashFileContent(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex").slice(0, 24)}`;
}

export function hashCommandOutput(stdout: string, stderr: string): string {
  return `sha256:${createHash("sha256").update(stdout).update(stderr).digest("hex").slice(0, 24)}`;
}

export function hashArtifactContent(content: unknown): string {
  const canonical = JSON.stringify(content, Object.keys(content as object).sort());
  return `sha256:${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}
