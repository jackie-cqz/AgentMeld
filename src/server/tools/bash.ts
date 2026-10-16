import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { currentPlatform, type Platform } from "@/server/platform";
import { registerPendingBash } from "@/server/pending-bash";
import { recordCommandEvidence } from "@/server/dispatch-tool-evidence";
import { findBannedPattern } from "@/server/security";
import {
  assertPathWithinWorkspace,
  BASH_OUTPUT_CHARS,
  BASH_TIMEOUT_MS
} from "@/server/workspace-utils";
import { TOOL_CAPABILITIES } from "@/server/tools/capabilities";
import type { ToolContext, ToolDef, ToolResult } from "@/server/tools/types";
import { startCommandJob } from "@/server/tools/command-jobs";

const ArgsSchema = z.object({
  command: z.string().min(1).max(4000),
  timeoutMs: z.number().int().min(1000).max(600000).optional()
});

// Commands that require user approval but are not banned
const APPROVAL_PATTERNS: RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|ci)\b/,
  // `npx <verification tool>` is exempt from approval because it is a
  // read-only check the platform already blesses, and gating it made unattended
  // runs hang forever on a command nothing dangerous happens in — an agent that
  // only wants to run `npx eslint` would sit in the approval queue until a human
  // clicked, and then fail its task for lack of a report.
  //
  // The exemption must match the tool name as a WHOLE token: with a trailing `\b`
  // the lookahead also excused `npx eslint-foo` / `npx eslint.exe`, which npx
  // happily fetches from the registry — an approval-free RCE path. `(?![\w.-])`
  // rejects those. The pattern is case-insensitive so `npx ESLINT` is exempt too.
  /\bnpx\b(?!\s+(?:--yes\s+)?(?:tsc|vite|vitest|eslint|oxlint)(?![\w.-]))/i,
  /\bpnpm\s+dlx\b/,
  /\bpip\s+install\b/,
  /\buv\s+sync\b/,
  /\bgit\s+reset\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+(checkout|restore)\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bdocker\b/,
];

const DEPENDENCY_COMMAND_PATTERNS: RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|ci)\b/i,
  /\bpip\s+install\b/i,
  /\buv\s+sync\b/i
];

export function needsApproval(command: string): boolean {
  return APPROVAL_PATTERNS.some((pattern) => pattern.test(command));
}

// Splits a shell command into the segments that actually execute. Pipeline
// stages (`|`, `|&`), newlines and background `&` each run a separate command,
// so every segment must be validated on its own — nothing may be discarded.
// The lone `&` in shell redirects such as `2>&1` is not a separator.
const COMMAND_SEPARATOR = /\s*(?:&&|\|\||\|&|;|\||\r?\n|(?<!>)&)\s*/;

function splitCommandSegments(command: string): string[] {
  return command
    .split(COMMAND_SEPARATOR)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

// Segmenting happens in splitCommandSegments; this only removes benign output
// redirects and must never drop a pipeline stage.
function stripOutputFilter(segment: string): string {
  return segment
    .replace(/\s+2>&1\b/g, "")
    .replace(/\s+1>\s*\$null\b/gi, "")
    .trim();
}

function isDirectoryChange(segment: string): boolean {
  return /^(?:cd|Set-Location|Push-Location)\b/i.test(segment.trim());
}

function isDependencyCommandSegment(segment: string): boolean {
  const command = stripOutputFilter(segment);
  return DEPENDENCY_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export function isDependencyOnlyCommand(command: string): boolean {
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return false;

  let sawDependencyCommand = false;
  for (const segment of segments) {
    if (isDirectoryChange(segment)) continue;
    if (!isDependencyCommandSegment(segment)) return false;
    sawDependencyCommand = true;
  }
  return sawDependencyCommand;
}

function containsPnpmDependencyMutation(command: string): boolean {
  return /\bpnpm\s+(?:install|add|remove|update|ci)\b/i.test(command);
}

function isNestedInsideHostProject(workspacePath: string): boolean {
  const hostRoot = path.resolve(process.cwd());
  const resolvedWorkspace = path.resolve(workspacePath);
  const relative = path.relative(hostRoot, resolvedWorkspace);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function getShell(platform: Platform): { cmd: string; args: string[] } {
  if (platform === "windows") {
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); `
      ]
    };
  }
  // POSIX: prefer user shell
  const userShell = process.env.SHELL || "/bin/sh";
  const basename = userShell.split("/").pop() ?? "";
  if (basename === "zsh" || basename === "bash") {
    return { cmd: userShell, args: ["-l", "-i", "-c"] };
  }
  return { cmd: "/bin/sh", args: ["-c"] };
}

const PLATFORM_DESCRIPTIONS: Record<Platform, string> = {
  posix:
    "Run a shell command inside workspace. Uses the user login shell (zsh/bash) when available, otherwise sh. " +
    "Any development command is allowed, including creating directories and writing files; use fs_list/fs_read/fs_patch/fs_write when you want path-guarded file access instead. " +
    "Dependency installation and other mutating package-manager commands ask the user for approval first. " +
    `Output: stdout+stderr merged, ${BASH_OUTPUT_CHARS} char limit, ${BASH_TIMEOUT_MS / 1000}s timeout. ` +
    "Still blocked by security policy: recursive deletion of the filesystem, sudo, fork bombs, curl | sh.",
  windows:
    "Run a PowerShell 5.1 command inside workspace. " +
    "Any development command is allowed, including creating directories and writing files; use fs_list/fs_read/fs_patch/fs_write when you want path-guarded file access instead. " +
    "Dependency installation and other mutating package-manager commands ask the user for approval first. " +
    `Output is UTF-8, stdout+stderr merged, ${BASH_OUTPUT_CHARS} char limit, ${BASH_TIMEOUT_MS / 1000}s timeout. ` +
    "Still blocked by security policy: format, shutdown, iex(iwr ...), reg delete."
};

export const bashTool: ToolDef = {
  name: "bash",
  capabilities: TOOL_CAPABILITIES.bash,
  description: PLATFORM_DESCRIPTIONS[currentPlatform()],
  parameters: {
    type: "object",
    required: ["command"],
    properties: {
      command: {
        type: "string",
        description: `The shell command to execute inside the workspace. ${
          currentPlatform() === "windows"
            ? "Uses PowerShell 5.1 syntax."
            : "Uses POSIX shell syntax."
        }`
      }
    }
  },
  handler: (args, ctx) => runValidatedBash(args, ctx)
};

export async function authorizeBashExecution(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` };
    }

    const command = parsed.data.command;
    const platform = currentPlatform();

    // 1. Check banned patterns. This is the only remaining content gate: it
    // names genuinely destructive host commands (recursive root deletion, sudo,
    // fork bombs, curl | sh, …), not "commands a build agent should not need".
    // The old verification-only and source-mutation gates are gone (issue #79):
    // bash is a general development tool now, so mkdir/cat >/sed -i and any
    // `npm run <script>` are ordinary commands, not policy violations.
    const banned = findBannedPattern(command, platform);
    if (banned) {
      return {
        ok: false,
        error: `Command blocked by security policy (pattern: ${banned.source}).`,
        code: "BASH_SECURITY_POLICY_BLOCKED",
        category: "security_policy",
      };
    }

    const isDependencyInstall = isDependencyOnlyCommand(command);

    if (
      isDependencyInstall &&
      containsPnpmDependencyMutation(command) &&
      isNestedInsideHostProject(ctx.workspacePath)
    ) {
      return {
        ok: false,
        code: "BASH_NESTED_PNPM_BLOCKED",
        category: "security_policy",
        error:
          "pnpm dependency changes are blocked in AgentMeld-managed nested workspaces because pnpm may resolve the host workspace and mutate AgentMeld's root node_modules. " +
          "Do not retry with pnpm or custom store-dir flags. Use npm install / npm ci inside the generated project, then use npm run build/test/lint for verification."
      };
    }

    // 2. Verify cwd is within workspace. The lease fixes the starting directory;
    // the command itself runs with the process user's reach, as the prompt says.
    let cwd: string;
    try {
      cwd = assertPathWithinWorkspace(ctx.workspacePath, ".");
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Workspace validation failed.",
        code: "WORKSPACE_PATH_ESCAPE",
        category: "security_policy",
      };
    }

    // 3. Approval check for dangerous-but-not-banned commands. This is a RECORD,
    // not a capability gate: the request and its decision stay auditable, and a
    // normal development command never reaches it.
    if (needsApproval(command)) {
      const approved = await registerPendingBash(
        ctx.conversationId, ctx.agentId, ctx.runId, command, cwd,
        `Command requires user approval: ${command.slice(0, 80)}`
      );
      if (!approved) {
        return {
          ok: false,
          error: "User rejected command execution.",
          code: "APPROVAL_REJECTED",
          category: "approval_rejected",
        };
      }
    }

    if (ctx.abortSignal.aborted) return { ok: false, error: "Command was cancelled before execution.", category: "approval_rejected" };
    return { ok: true, value: { command, cwd, timeoutMs: parsed.data.timeoutMs ?? 300000 } };
}

export async function runValidatedBash(args: unknown, ctx: ToolContext, background = false): Promise<ToolResult> {
    const admission = await authorizeBashExecution(args, ctx);
    if (!admission.ok) return admission;
    const { command, cwd, timeoutMs } = admission.value as { command: string; cwd: string; timeoutMs: number };
    const platform = currentPlatform();

    // Execution is separate so native Harness tools can share the same admission policy.
    const shell = getShell(platform);

    let shellCommand: string;
    let shellArgs: string[];
    if (platform === "windows") {
      shellCommand = shell.cmd;
      shellArgs = [...shell.args.slice(0, -1), shell.args[shell.args.length - 1] + command];
    } else {
      shellCommand = shell.cmd;
      shellArgs = [...shell.args, command];
    }

    if (background) {
      try { return { ok: true, value: startCommandJob(shellCommand, shellArgs, cwd, command, ctx, timeoutMs) }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Job could not start." }; }
    }
    const result = await executeCommand(shellCommand, shellArgs, cwd, ctx.abortSignal);
    if (ctx.parentRunId) {
      recordCommandEvidence(ctx.runId, {
        command,
        cwd,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        isError: result.exitCode === null && !result.timedOut,
      });
    }
    return {
      ok: true,
      value: {
        cwd,
        command,
        exitCode: result.exitCode,
        output: result.output,
        truncated: result.truncated,
        timedOut: result.timedOut
      }
    };
}

interface CommandResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

function executeCommand(
  cmd: string,
  args: string[],
  cwd: string,
  abortSignal: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // Timeout
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, currentPlatform());
      settle({ exitCode: null, output, truncated: output.length >= BASH_OUTPUT_CHARS, timedOut });
    }, BASH_TIMEOUT_MS);

    // Collect stdout
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
      if (output.length > BASH_OUTPUT_CHARS * 2) {
        // Too much output, kill
        killProcessTree(child, currentPlatform());
      }
    });

    // Collect stderr
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });

    // Completion
    child.on("close", (code) => {
      clearTimeout(timer);
      const truncated = output.length > BASH_OUTPUT_CHARS;
      settle({
        exitCode: code,
        output: truncated ? output.slice(0, BASH_OUTPUT_CHARS) : output,
        truncated,
        timedOut: false
      });
    });

    // Error
    child.on("error", (err) => {
      clearTimeout(timer);
      settle({
        exitCode: null,
        output: `Failed to execute command: ${err.message}`,
        truncated: false,
        timedOut: false
      });
    });

    // Abort
    const onAbort = () => {
      clearTimeout(timer);
      killProcessTree(child, currentPlatform());
      settle({ exitCode: null, output, truncated: output.length >= BASH_OUTPUT_CHARS, timedOut: true });
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

function killProcessTree(child: ChildProcess, platform: Platform): void {
  if (platform === "windows" && child.pid) {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true });
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
}
