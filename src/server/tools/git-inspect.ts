import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveToolPath, toolProcessEnv } from "@/server/tools/workspace-access";
import { isPathWithin } from "@/server/workspace-utils";
import type { ToolDef } from "@/server/tools/types";
import { TOOL_CAPABILITIES } from "@/server/tools/capabilities";

async function git(args: string[], cwd: string, root: string, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
    const child = spawn("git", ["--no-pager", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", "diff.ignoreSubmodules=all", "-c", `core.hooksPath=${nullFile}`, "-c", `core.attributesFile=${nullFile}`, "-c", `core.excludesFile=${nullFile}`, "-c", "diff.external=", ...args], {
      cwd, windowsHide: true, env: { ...toolProcessEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: nullFile, GIT_CONFIG_GLOBAL: nullFile, GIT_CEILING_DIRECTORIES: root,
        GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    let output = ""; let error = ""; let overflow = false;
    child.stdout.on("data", chunk => { output += String(chunk); if (output.length > 50000) { overflow = true; child.kill(); } });
    child.stderr.on("data", chunk => { error = (error + String(chunk)).slice(0, 2000); });
    child.on("error", reject); child.on("close", code => overflow ? resolve(`${output.slice(0, 50000)}\n[output truncated]`) : code === 0 ? resolve(output) : reject(new Error(error || `Git exited ${code}.`)));
  });
}

export const gitInspectTool: ToolDef = {
  capabilities: TOOL_CAPABILITIES.git_inspect,
  name: "git_inspect", description: "Read-only Git status, working/staged diff or recent log inside a workspace-owned repository. Never stages, commits, resets or pushes. No arbitrary Git arguments or hooks/external diff execution. Output capped at 50k characters.",
  parameters: { type: "object", required: ["action"], properties: { action: { type: "string", enum: ["status", "diff", "log"] }, path: { type: "string" }, staged: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 20 } } },
  async handler(args, ctx) {
    const parsed = z.object({ action: z.enum(["status", "diff", "log"]), path: z.string().default("."), staged: z.boolean().default(false), limit: z.number().int().min(1).max(20).default(10) }).safeParse(args);
    if (!parsed.success) return { ok: false, error: "Invalid Git inspection arguments." };
    try {
      // Issue #79: the path is resolved as given and is not refused for leaving
      // the workspace. The repository that this tool may inspect is still the
      // workspace-owned one — that is the tool's definition (bounded read-only
      // inspection of the workspace's own repository, reported relative to it),
      // not a per-Agent grant: native bash already runs any git command. The
      // upward search is clamped to the workspace root so a path above it cannot
      // walk to the filesystem root.
      const root = fs.realpathSync(ctx.workspacePath); const cwd = resolveToolPath(root, parsed.data.path);
      if (!fs.statSync(cwd).isDirectory()) throw new Error("path must be a repository directory.");
      // Require a physical .git directory within the workspace; linked host worktrees are not admitted.
      let repo = cwd;
      while (!fs.existsSync(path.join(repo, ".git")) && repo !== root && isPathWithin(repo, root)) repo = path.dirname(repo);
      const marker = path.join(repo, ".git");
      if (!isPathWithin(repo, root) || !fs.lstatSync(marker).isDirectory() || fs.lstatSync(marker).isSymbolicLink() || !isPathWithin(fs.realpathSync(marker), root)) throw new Error("No workspace-owned Git repository. Linked or external repositories are not allowed.");
      if (fs.existsSync(path.join(marker, "commondir")) || fs.existsSync(path.join(marker, "objects", "info", "alternates"))) throw new Error("Git common directories and alternate object stores are not allowed.");
      const pending = [marker]; let entries = 0;
      while (pending.length) for (const entry of fs.readdirSync(pending.pop()!, { withFileTypes: true })) {
        if (++entries > 10000) throw new Error("Repository metadata is too large for bounded inspection.");
        if (entry.isSymbolicLink()) throw new Error("Repository metadata links are not allowed.");
        if (entry.isDirectory()) pending.push(path.join(entry.parentPath, entry.name));
      }
      // Git resolves includes before command-line overrides. Refuse them before launching it.
      for (const filename of ["config", "config.worktree"]) {
        const config = path.join(marker, filename);
        if (!fs.existsSync(config)) continue;
        if (fs.statSync(config).size > 65536) throw new Error("Repository config exceeds the inspection limit.");
        const text = fs.readFileSync(config, "utf8").replace(/\\\r?\n/g, "");
        if (/^\s*\[\s*include(?:if)?(?:[\s\]"])/im.test(text)) throw new Error("Git config includes are not supported by workspace inspection.");
      }
      const actualRoot = (await git(["rev-parse", "--show-toplevel"], cwd, root, ctx.abortSignal)).trim();
      if (fs.realpathSync(actualRoot) !== repo) throw new Error("Git repository boundary mismatch.");
      const commandArgs = parsed.data.action === "status" ? ["status", "--short", "--untracked-files=normal"] : parsed.data.action === "log" ? ["log", `-${parsed.data.limit}`, "--format=%h %ad %s", "--date=iso-strict"] : ["diff", "--no-ext-diff", "--no-textconv", ...(parsed.data.staged ? ["--cached"] : []), "--", "."];
      return { ok: true, value: { action: parsed.data.action, repository: path.relative(root, repo) || ".", output: await git(commandArgs, cwd, root, ctx.abortSignal), readOnly: true } };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Git inspection failed." }; }
  }
};
