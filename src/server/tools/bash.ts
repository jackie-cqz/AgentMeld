import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { currentPlatform, type Platform } from "@/server/platform";
import { registerPendingBash } from "@/server/pending-bash";
import { recordCommandEvidence } from "@/server/dispatch-tool-evidence";
import { findBannedPattern, getBannedPatterns } from "@/server/security";
import {
  assertPathWithinWorkspace,
  BASH_OUTPUT_CHARS,
  BASH_TIMEOUT_MS
} from "@/server/workspace-utils";
import type { ToolDef } from "@/server/tools/types";

const ArgsSchema = z.object({
  command: z.string().min(1).max(4000)
});

// Commands that require user approval but are not banned
const APPROVAL_PATTERNS: RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|ci)\b/,
  /\bnpx\b/,
  /\bpnpm\s+dlx\b/,
  /\bpip\s+install\b/,
  /\buv\s+sync\b/,
  /\bgit\s+reset\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+(checkout|restore)\b/,
  /\brm\s+-rf\b/,
  /\bfind\s+.*-delete\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bdocker\b/,
  /\bRemove-Item\b.*-Recurse/i,
  /\bRemove-Item\b.*-Force/i
];

function needsApproval(command: string): boolean {
  return APPROVAL_PATTERNS.some((pattern) => pattern.test(command));
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
    "Use POSIX syntax: ls, grep, cat, git, npm. " +
    `Output: stdout+stderr merged, ${BASH_OUTPUT_CHARS} char limit, ${BASH_TIMEOUT_MS / 1000}s timeout. ` +
    "Blocked: rm -rf /, sudo, fork bombs, curl | sh.",
  windows:
    "Run a PowerShell 5.1 command inside workspace. " +
    "Use PowerShell syntax: Get-ChildItem, Select-String, Get-Content, git, npm. " +
    `Output is UTF-8, stdout+stderr merged, ${BASH_OUTPUT_CHARS} char limit, ${BASH_TIMEOUT_MS / 1000}s timeout. ` +
    "Blocked: Remove-Item -Recurse -Force, format, shutdown, iex(iwr ...), reg delete."
};

export const bashTool: ToolDef = {
  name: "bash",
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
  async handler(args, ctx) {
    const parsed = ArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` };
    }

    const command = parsed.data.command;
    const platform = currentPlatform();

    // 1. Check banned patterns
    const banned = findBannedPattern(command, platform);
    if (banned) {
      if (ctx.parentRunId) recordCommandFailure(ctx.runId, command);
      return { ok: false, error: `Command blocked by security policy (pattern: ${banned.source}).` };
    }

    // 2. Verify cwd is within workspace
    let cwd: string;
    try {
      cwd = assertPathWithinWorkspace(ctx.workspacePath, ".");
    } catch (error) {
      if (ctx.parentRunId) recordCommandFailure(ctx.runId, command);
      return { ok: false, error: error instanceof Error ? error.message : "Workspace validation failed." };
    }

    // 3. Approval check for dangerous-but-not-banned commands
    if (needsApproval(command)) {
      const approved = await registerPendingBash(
        ctx.conversationId, ctx.agentId, ctx.runId, command, cwd,
        `Command requires user approval: ${command.slice(0, 80)}`
      );
      if (!approved) {
        if (ctx.parentRunId) recordCommandFailure(ctx.runId, command, cwd);
        return { ok: false, error: "User rejected command execution." };
      }
    }

    // 4. Execute
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

    const result = await executeCommand(shellCommand, shellArgs, cwd, ctx.abortSignal);
    if (ctx.parentRunId) {
      recordCommandEvidence(ctx.runId, {
        command,
        cwd,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        isError: result.exitCode === null && !result.timedOut
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
};

function recordCommandFailure(runId: string, command: string, cwd?: string): void {
  recordCommandEvidence(runId, {
    command,
    cwd,
    exitCode: null,
    timedOut: false,
    isError: true
  });
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
