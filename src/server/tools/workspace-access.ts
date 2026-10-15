import fs from "node:fs";
import path from "node:path";
import { assertRealPathWithinWorkspace, isPathWithin } from "@/server/workspace-utils";

export const SEARCH_EXCLUDES = ["**/node_modules/**", "**/.git/**", "**/.next/**", "**/dist/**", "**/build/**", "**/coverage/**", "**/.env*", "**/*.pem", "**/*.key", "**/.npmrc", "**/.netrc", "**/.pypirc", "**/.git-credentials", "**/.ssh/**", "**/.aws/**"];

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
