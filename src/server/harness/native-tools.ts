import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { scanWorkspaceUsage, checkSandboxQuota } from "@/server/workspace-utils";
import { getConversation } from "@/server/repositories";
import { registerPendingWrite } from "@/server/pending-writes";
import { authorizeBashExecution } from "@/server/tools/bash";
import { captureEvidence } from "@/server/evidence/evidence-collector";
import { recordFileWrite } from "@/server/dispatch-file-writes";
import { recordCommandEvidence, recordFileWriteEvidence } from "@/server/dispatch-tool-evidence";
import type { ToolContext, ToolResult } from "@/server/tools/types";

/**
 * The platform's workspace-native tool family, in PLATFORM names (#25 P2).
 *
 * These are the tools an engine is expected to implement itself (read/write/edit
 * a file, run a shell). The platform does not execute them; it admits them,
 * applies approvals/quota/integrity checks and records the outcome as evidence.
 * A driver maps its own native names onto these names, so this list — not an
 * engine's vocabulary — is what the bridge can admit.
 *
 * Order matters only so a driver's derived native list keeps its historical
 * ordering (Pi's CLI `--tools` argument).
 */
export const NATIVE_WORKSPACE_TOOLS = [
  "fs_read",
  "fs_write",
  "fs_patch",
  "bash",
  "fs_list",
  "fs_search",
  "fs_glob",
] as const;

export type NativeWorkspaceToolName = (typeof NATIVE_WORKSPACE_TOOLS)[number];

const NATIVE_WORKSPACE_TOOL_SET: ReadonlySet<string> = new Set(NATIVE_WORKSPACE_TOOLS);

export function isNativeWorkspaceTool(name: string): name is NativeWorkspaceToolName {
  return NATIVE_WORKSPACE_TOOL_SET.has(name);
}

/**
 * One native tool call an engine is about to run, described in platform terms.
 *
 * `args` is the engine's own argument object, recorded verbatim in evidence. The
 * platform only reads the fields it actually adjudicates (`targetPath`,
 * `command`, `timeoutMs`) so a second engine does not have to imitate Pi's
 * argument shape to get admission.
 */
export interface HarnessNativeCall {
  /** Stable per-invocation call id from the engine; the bridge refuses a replay. */
  callId: string;
  /** PLATFORM tool name (`fs_read`, `fs_write`, `fs_patch`, `bash`, …). */
  name: string;
  /** Engine arguments, kept as-is for evidence. */
  args: Record<string, unknown>;
  /**
   * The path the engine is about to touch (relative to the workspace or
   * absolute), or `null`/absent for a non-file call. The platform resolves a
   * relative path against the workspace root, exactly as the engine's cwd is the
   * workspace root.
   */
  targetPath?: string | null;
  /** `bash` only: the command string the engine is about to run. */
  command?: string;
  /** `bash` only: requested timeout in milliseconds. */
  timeoutMs?: number;
}

/** The platform's admission receipt for one native call. */
export interface NativeAdmission {
  call: HarnessNativeCall;
  startedAt: number;
  absolutePath?: string;
  beforeHash?: string | null;
  expectedHash?: string;
}

/** Engine-side outcome of a native call, in the smallest neutral shape. */
export interface HarnessNativeOutcome {
  /** Text the engine produced (already extracted from its own result shape). */
  text: string;
  isError: boolean;
}

export interface NativeEvidenceOptions {
  /** Engine id used only as a provenance label (`<source>-native`), e.g. "pi". */
  source: string;
  /** Fallback error text when a failed native call produced no message. */
  failureMessage: string;
}

/**
 * Authorize immediately before the engine's native tool runs, without executing
 * the tool ourselves. Approval/quota enforcement that has to see proposed bytes
 * happens in `authorizeNativeChange`.
 */
export async function authorizeNativeTool(call: HarnessNativeCall, ctx: ToolContext): Promise<NativeAdmission> {
  // Capability is open (issue #79): the only names this rejects are ones the
  // platform has no native semantics for, which means the bridge received a call
  // it never provisioned. There is deliberately no per-Agent tool whitelist.
  if (!isNativeWorkspaceTool(call.name)) throw new Error(`Unknown native workspace tool: ${call.name}.`);
  ctx.abortSignal.throwIfAborted();
  const admission: NativeAdmission = { call, startedAt: Date.now() };
  if (call.name === "bash") {
    const allowed = await authorizeBashExecution({ command: call.command, timeoutMs: call.timeoutMs }, ctx);
    if (!allowed.ok) throw new Error(allowed.error);
    ctx.abortSignal.throwIfAborted();
    return admission;
  }
  // Issue #79: native file tools are full-access, exactly like a standalone
  // engine agent. A relative path is resolved against the invocation's cwd (the
  // workspace root), but it is NOT refused for leaving the workspace: `..`, an
  // absolute path and a symlink out are all admitted. What still runs is the
  // resource/integrity machinery below and in `authorizeNativeChange`
  // (file-size limit, quota accounting, approval, evidence hashing).
  const relative = typeof call.targetPath === "string" ? call.targetPath : ".";
  admission.absolutePath = resolveNativePath(ctx.workspacePath, relative);
  return admission;
}

/** The engine computed the edit. Its write operation pauses here before any bytes change. */
export async function authorizeNativeChange(admission: NativeAdmission, absolutePath: string, proposed: string, ctx: ToolContext): Promise<void> {
  ctx.abortSignal.throwIfAborted();
  if (admission.call.name !== "fs_write" && admission.call.name !== "fs_patch") throw new Error("This tool cannot request a file change.");
  if (admission.expectedHash !== undefined) throw new Error("This native change was already authorized.");
  const currentPath = resolveNativePath(ctx.workspacePath, absolutePath);
  if (currentPath !== admission.absolutePath) throw new Error("The native tool attempted to change a different file.");
  const old = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, "utf8") : null;
  if (Buffer.byteLength(proposed, "utf8") > 100 * 1024) throw new Error("Native write exceeds the 100 KB file limit.");
  const quota = checkSandboxQuota(scanWorkspaceUsage(ctx.workspacePath), Buffer.byteLength(proposed), Buffer.byteLength(old ?? ""), old === null);
  if (quota) throw new Error(quota);
  admission.beforeHash = old === null ? null : digest(old);
  const conversation = getConversation(ctx.conversationId);
  if (!conversation) throw new Error("The conversation no longer exists.");
  if (conversation.fsWriteApprovalMode !== "auto") {
    const approved = await registerPendingWrite(ctx.conversationId, ctx.agentId, ctx.runId, path.relative(ctx.workspacePath, currentPath), currentPath, old, proposed);
    if (!approved) throw new Error("User rejected the native file change.");
    ctx.abortSignal.throwIfAborted();
    const current = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, "utf8") : null;
    if (current !== old) throw new Error("The file changed while approval was pending. Read it again before editing.");
  }
  ctx.abortSignal.throwIfAborted();
  admission.expectedHash = digest(proposed);
}

/**
 * Record the engine's native outcome as the platform's tool result plus evidence.
 *
 * The normalized `ToolResult` values are the ones Pi's bridge already returned
 * (file writes carry path/hash/`applied`, `bash` carries command/cwd/output,
 * reads carry a content hash); a second engine gets the same shapes because the
 * platform, not the engine, builds them.
 */
export async function captureNativeResult(
  admission: NativeAdmission,
  outcome: HarnessNativeOutcome,
  ctx: ToolContext,
  options: NativeEvidenceOptions,
): Promise<ToolResult> {
  const { name, args } = admission.call;
  const text = outcome.text;
  let normalized: ToolResult = outcome.isError
    ? { ok: false, error: text || options.failureMessage }
    : { ok: true, value: { output: text } };
  let evidenceArgs = args;
  if (name === "bash") {
    const value = { command: args.command, cwd: ctx.workspacePath, output: text, exitCode: outcome.isError ? null : 0, timedOut: /timed? out/i.test(text) };
    normalized = outcome.isError ? { ok: false, error: text, ...{ value } } : { ok: true, value };
    recordCommandEvidence(ctx.runId, { command: String(args.command), cwd: ctx.workspacePath, exitCode: value.exitCode, timedOut: value.timedOut, isError: outcome.isError });
  } else if (!outcome.isError && admission.absolutePath && (name === "fs_write" || name === "fs_patch")) {
    const absolutePath = admission.absolutePath;
    const content = fs.readFileSync(absolutePath, "utf8");
    if (digest(content) !== admission.expectedHash) throw new Error("The native tool result does not match the authorized file change.");
    const action = admission.beforeHash === null ? "created" : "modified";
    evidenceArgs = { ...args, path: path.relative(ctx.workspacePath, absolutePath), action };
    normalized = { ok: true, value: { path: evidenceArgs.path, absolutePath, bytes: Buffer.byteLength(content), contentHash: digest(content), applied: `${options.source}-native` } };
    recordFileWrite(ctx.runId, absolutePath, content);
    recordFileWriteEvidence(ctx.runId, { path: String(evidenceArgs.path), absolutePath, action });
  } else if (!outcome.isError && name === "fs_read" && admission.absolutePath) {
    const content = fs.readFileSync(admission.absolutePath);
    normalized = { ok: true, value: { content: text, contentHash: createHash("sha256").update(content).digest("hex") } };
  }
  await captureEvidence({ toolName: name, args: evidenceArgs, result: normalized, context: ctx, durationMs: Date.now() - admission.startedAt, callId: admission.call.callId });
  return normalized;
}

/**
 * Resolve a native path the way the engine does: a relative path is relative to
 * the invocation cwd (the workspace root), an absolute path is used as-is.
 *
 * Deliberately NOT `assertRealPathWithinWorkspace` / `resolveSafePath`: those
 * throw when the target leaves the workspace, which would re-introduce the
 * capability gate issue #79 removed. This returns the LOGICAL path (never the
 * realpath) so evidence and conflict records keep the path the Agent used.
 */
function resolveNativePath(workspacePath: string, targetPath: string): string {
  return path.resolve(workspacePath, targetPath);
}

function digest(content: string): string { return createHash("sha256").update(content).digest("hex"); }
