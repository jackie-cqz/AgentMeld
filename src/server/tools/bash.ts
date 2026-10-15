import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { currentPlatform, type Platform } from "@/server/platform";
import { registerPendingBash } from "@/server/pending-bash";
import { recordCommandEvidence } from "@/server/dispatch-tool-evidence";
import { findBannedPattern } from "@/server/security";
import {
  assertPathWithinWorkspace,
  BASH_OUTPUT_CHARS,
  BASH_TIMEOUT_MS,
  isPathWithin
} from "@/server/workspace-utils";
import { TOOL_CAPABILITIES } from "@/server/tools/capabilities";
import type { ToolDef } from "@/server/tools/types";

const ArgsSchema = z.object({
  command: z.string().min(1).max(4000)
});

// Commands that require user approval but are not banned
const APPROVAL_PATTERNS: RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|ci)\b/,
  // `npx <verification tool>` is already declared a legitimate verification
  // command by VERIFICATION_PATTERNS. Demanding approval for it as well made
  // unattended runs hang forever on a command the policy itself blesses — an
  // agent that only wants to run `npx eslint` would sit in the approval queue
  // until a human clicked, and then fail its task for lack of a report.
  //
  // The exemption must match the tool name as a WHOLE token: with a trailing `\b`
  // the lookahead also excused `npx eslint-foo` / `npx eslint.exe`, which npx
  // happily fetches from the registry — an approval-free RCE path. `(?![\w.-])`
  // rejects those. The pattern is case-insensitive because VERIFICATION_PATTERNS
  // is, and a case mismatch would recreate the very hang this fixes.
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

const SOURCE_MUTATION_PATTERNS: RegExp[] = [
  /\b(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item)\b/i,
  /\b(del|erase|copy|move|ren|rename)\b/i,
  /\bsed\b[^|;]*(?:-i|--in-place)\b/i,
  /\bperl\b[^|;]*-(?:p?i|i)/i,
  /\bpython(?:3)?\b[^|;]*\b(open|write_text|shutil|Path\()/i,
  /(^|[^2])>{1,2}(?!&1)/
];

/**
 * An `npm/pnpm/yarn/bun run <script>` invocation whose script name starts with a
 * verification family word.
 *
 * The name is captured as a WHOLE shell token — the family word plus everything
 * up to the next whitespace. A `\b` is not enough: it also ends at `.` and `/`,
 * so `bun run build.evil` was classified as `build` while bun resolves the rest
 * to a FILE, and the declaration check then asked about a script the shell never
 * ran. Classification and extraction share this one pattern, so the name that is
 * classified is by construction the name that gets looked up.
 */
const RUN_SCRIPT_PATTERN = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?((?:build|test|lint|typecheck|check)\b\S*)/i;

const VERIFICATION_PATTERNS: RegExp[] = [
  RUN_SCRIPT_PATTERN,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:ls|list)\b/i,
  // Tool names are matched as whole tokens (`(?![\w.-])`, not `\b`): otherwise
  // `npx eslint-foo` / `pnpm exec eslint-foo` count as verification and reach the
  // registry / a differently-named binary while bypassing the approval gate.
  /\bnpx\s+(?:--yes\s+)?(?:tsc|vite|vitest|eslint|oxlint)(?![\w.-])/i,
  /\bpnpm\s+exec\s+(?:tsc|vite|vitest|eslint|oxlint)(?![\w.-])/i,
  /\byarn\s+(?:tsc|vite|vitest|eslint|oxlint)(?![\w.-])/i,
  /\bbun\s+(?:x\s+)?(?:tsc|vite|vitest|eslint|oxlint)(?![\w.-])/i,
  /^(?:python(?:3(?:\.\d+)*)?|py(?:\s+-\d+(?:\.\d+)?)?)\s+-m\s+(?:unittest|pytest)\b/i,
  /^pytest(?:\.exe)?\b/i,
  /^(?:python(?:3(?:\.\d+)*)?|py(?:\s+-\d+(?:\.\d+)?)?)\s+(?:--version|-V)\b/i
];

export function needsApproval(command: string): boolean {
  return APPROVAL_PATTERNS.some((pattern) => pattern.test(command));
}

function findSourceMutationPattern(command: string): RegExp | null {
  for (const pattern of SOURCE_MUTATION_PATTERNS) {
    if (pattern.test(command)) return pattern;
  }
  return null;
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

function isVerificationSegment(segment: string): boolean {
  const command = stripOutputFilter(segment);
  return VERIFICATION_PATTERNS.some((pattern) => pattern.test(command));
}

function isDependencyCommandSegment(segment: string): boolean {
  const command = stripOutputFilter(segment);
  return DEPENDENCY_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export function isVerificationOnlyCommand(command: string): boolean {
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return false;

  let sawVerification = false;
  for (const segment of segments) {
    if (isDirectoryChange(segment)) continue;
    if (!isVerificationSegment(segment)) return false;
    sawVerification = true;
  }
  return sawVerification;
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

const DIRECTORY_CHANGE = /^(?:cd|Set-Location|Push-Location)\s+(.+)$/i;

/** `npm --prefix <dir> run …`, `pnpm -C <dir>`, `yarn --cwd <dir>` … */
const PROJECT_DIRECTORY_FLAG = /(?:^|\s)(?:-w|--workspace|--prefix|-C|--cwd)(?:[=\s]+)(\S+)/i;

export interface VerificationScriptRun {
  name: string;
  /** Directory the script runs in, or null when it cannot be determined. */
  cwd: string | null;
}

/**
 * The verification-family scripts a command asks to run, each with the directory
 * it will run in. `cd` segments are tracked in order, and an explicit project
 * directory flag redirects the lookup the way it redirects npm.
 *
 * `cwd` is null when the directory cannot be resolved statically — a shell
 * variable, `~`, or a glob. The caller must refuse those instead of assuming a
 * directory: the shell would run somewhere this code never looked.
 */
export function findVerificationScriptRuns(
  command: string,
  baseCwd: string
): VerificationScriptRun[] {
  const runs: VerificationScriptRun[] = [];
  let cwd: string | null = baseCwd;

  for (const segment of splitCommandSegments(command)) {
    const cleaned = stripOutputFilter(segment);

    if (isDirectoryChange(cleaned)) {
      cwd = resolveDirectoryChange(cleaned, cwd);
      continue;
    }

    const script = cleaned.match(RUN_SCRIPT_PATTERN);
    if (!script) continue;
    runs.push({ name: script[1], cwd: applyProjectDirectoryFlag(cleaned, cwd) });
  }

  return runs;
}

/** `cd [-flags] <dir>` resolved against the current directory; null when unknown. */
function resolveDirectoryChange(segment: string, current: string | null): string | null {
  const match = segment.match(DIRECTORY_CHANGE);
  if (!match || current === null) return current;

  const target = match[1]
    .trim()
    // Drop leading options — `-P`, `-L`, and the `--` separator — before the path.
    .replace(/^(?:(?:--?[A-Za-z][A-Za-z0-9-]*|--)(?:\s+|$))+/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  return target && !isDynamicShellWord(target) ? path.resolve(current, target) : null;
}

function applyProjectDirectoryFlag(segment: string, current: string | null): string | null {
  const flag = segment.match(PROJECT_DIRECTORY_FLAG);
  if (!flag || current === null) return current;

  const target = flag[1].replace(/^["']|["']$/g, "");
  return target && !isDynamicShellWord(target) ? path.resolve(current, target) : null;
}

/** Shell words this code cannot turn into a path. */
function isDynamicShellWord(word: string): boolean {
  return word.includes("$") || word.startsWith("~") || /[*?[\]]/.test(word);
}

/**
 * Decide whether a verification script may run.
 *
 * npm resolves a script by walking up from the working directory to the nearest
 * package.json, so that manifest is the one that decides — and it has to sit
 * inside the workspace, otherwise the command would run the host project's
 * script. Reusing `isPathWithin` on a realpath keeps symlinks from pointing out
 * of the sandbox.
 */
function checkDeclaredScript(
  run: VerificationScriptRun,
  workspaceRoot: string
): { ok: true } | { ok: false; code: string; error: string } {
  if (run.cwd === null) {
    return {
      ok: false,
      code: "BASH_SCRIPT_DIRECTORY_UNKNOWN",
      error:
        `Cannot tell which directory "${run.name}" would run in (a shell variable, ~, or a glob is involved), ` +
        `so it cannot be checked against a package.json. Use a literal path.`,
    };
  }

  const directory = realPathOrNull(run.cwd);
  if (!directory || !isPathWithin(directory, workspaceRoot)) {
    return {
      ok: false,
      code: "BASH_SCRIPT_OUTSIDE_WORKSPACE",
      error:
        `"${run.name}" would run outside the workspace (${run.cwd}). ` +
        `bash only verifies scripts declared inside it.`,
    };
  }

  const manifest = findApplicableManifest(directory);
  if (!manifest) {
    // No package.json anywhere above: npm cannot run a script either, so let its
    // own error be the feedback.
    return { ok: true };
  }

  if (!isPathWithin(manifest.directory, workspaceRoot)) {
    return {
      ok: false,
      code: "BASH_SCRIPT_MANIFEST_OUTSIDE_WORKSPACE",
      error:
        `"${run.name}" would resolve to ${path.join(manifest.directory, "package.json")}, which is outside ` +
        `the workspace. bash only verifies scripts declared inside it.`,
    };
  }

  if (!manifest.scripts.has(run.name)) {
    return {
      ok: false,
      code: "BASH_UNDECLARED_SCRIPT",
      error:
        `Script "${run.name}" is not declared in ${path.join(manifest.directory, "package.json")}. ` +
        `bash only runs build/test/lint/typecheck/check scripts the workspace declares.`,
    };
  }

  return { ok: true };
}

function realPathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** The package.json npm would use for a directory: the nearest one at or above it. */
function findApplicableManifest(
  directory: string
): { directory: string; scripts: Set<string> } | null {
  let current = directory;

  for (;;) {
    const manifestPath = path.join(current, "package.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
          scripts?: Record<string, unknown>;
        };
        const scripts =
          parsed && typeof parsed === "object" && parsed.scripts && typeof parsed.scripts === "object"
            ? new Set(Object.keys(parsed.scripts))
            : new Set<string>();
        return { directory: current, scripts };
      } catch {
        // A manifest npm cannot parse is one it cannot run a script from either.
        return { directory: current, scripts: new Set<string>() };
      }
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
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
    "Run a verification shell command inside workspace. Dependency installation commands are allowed only after user approval. Uses the user login shell (zsh/bash) when available, otherwise sh. " +
    "Use bash for build/test/lint/typecheck/dependency-list verification, including Python unittest/pytest, and approved dependency installation only. Use fs_list/fs_read/fs_patch/fs_write for file inspection or source changes. " +
    `Output: stdout+stderr merged, ${BASH_OUTPUT_CHARS} char limit, ${BASH_TIMEOUT_MS / 1000}s timeout. ` +
    "Blocked: source mutation, recursive deletion, sudo, fork bombs, curl | sh.",
  windows:
    "Run a verification PowerShell 5.1 command inside workspace. " +
    "Use PowerShell only for build/test/lint/typecheck/dependency-list verification, including Python unittest/pytest, and approved dependency installation. Use fs_list/fs_read/fs_patch/fs_write for file inspection or source changes. " +
    `Output is UTF-8, stdout+stderr merged, ${BASH_OUTPUT_CHARS} char limit, ${BASH_TIMEOUT_MS / 1000}s timeout. ` +
    "Blocked: source mutation, Remove-Item/rmdir deletion, format, shutdown, iex(iwr ...), reg delete."
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
        description: `The build/test/lint/typecheck/dependency-list verification command, or dependency installation command that requires user approval, to execute inside the workspace. ${
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
      return {
        ok: false,
        error: `Command blocked by security policy (pattern: ${banned.source}).`,
        code: "BASH_SECURITY_POLICY_BLOCKED",
        category: "security_policy",
      };
    }

    const mutationPattern = findSourceMutationPattern(command);
    if (mutationPattern) {
      return {
        ok: false,
        code: "BASH_SOURCE_MUTATION_BLOCKED",
        category: "security_policy",
        error:
          "Command blocked by bash verification-only policy. " +
          "Do not retry this with PowerShell/Bash. Use fs_mkdir for directories, fs_patch for existing source edits, fs_write for new/full files, and fs_list/fs_read for directory or file inspection. " +
          "bash may still be used for npm/pnpm install after user approval, and for build/test/lint/typecheck verification commands " +
          `(pattern: ${mutationPattern.source}).`
      };
    }

    const isDependencyInstall = isDependencyOnlyCommand(command);
    if (!isVerificationOnlyCommand(command) && !isDependencyInstall) {
      return {
        ok: false,
        code: "BASH_VERIFICATION_ONLY",
        category: "security_policy",
        error:
          "Command blocked by bash verification-only policy. " +
          "bash is only for build/test/lint/typecheck/dependency-list commands, including Python unittest/pytest, or approved dependency installation. " +
          "For directories call fs_mkdir, for inspection call fs_list/fs_read now, and for source changes call fs_patch for existing files or fs_write for new/full files. " +
          "Do not use Get-ChildItem, mkdir, cat, Set-Content, echo redirection, sed, arbitrary python scripts, or shell copy commands for source inspection or edits."
      };
    }

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

    // 2. Verify cwd is within workspace
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

    // 3. `npm run <script>` executes whatever the project declares, so run only
    // scripts the workspace actually declares. The verification patterns match by
    // name family, which on its own also accepted names no project declares
    // (`npm run build-evil`) — and a script nobody declared is arbitrary code
    // execution wearing a build step's name.
    //
    // A script that cannot be located inside the workspace is refused rather than
    // waved through: `cd` moves the shell (the sandbox only fixes the initial
    // directory), and npm walks up to the nearest package.json, so "I could not
    // find it" must not mean "allow it".
    const workspaceRoot = realPathOrNull(cwd) ?? cwd;
    for (const scriptRun of findVerificationScriptRuns(command, cwd)) {
      const check = checkDeclaredScript(scriptRun, workspaceRoot);
      if (!check.ok) {
        return { ok: false, code: check.code, category: "security_policy", error: check.error };
      }
    }

    // 4. Approval check for dangerous-but-not-banned commands
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

    // 5. Execute
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
};

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
