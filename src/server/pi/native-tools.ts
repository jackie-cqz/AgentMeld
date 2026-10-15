import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertRealPathWithinWorkspace, scanWorkspaceUsage, checkSandboxQuota } from "@/server/workspace-utils";
import { getConversation } from "@/server/repositories";
import { registerPendingWrite } from "@/server/pending-writes";
import { authorizeBashExecution } from "@/server/tools/bash";
import { captureEvidence } from "@/server/evidence/evidence-collector";
import { recordFileWrite } from "@/server/dispatch-file-writes";
import { recordCommandEvidence, recordFileWriteEvidence } from "@/server/dispatch-tool-evidence";
import type { ToolContext, ToolResult } from "@/server/tools/types";

export const PI_NATIVE_TO_PLATFORM: Record<string, string> = {
  read: "fs_read", write: "fs_write", edit: "fs_patch", bash: "bash",
  ls: "fs_list", grep: "fs_search", find: "fs_glob",
};

export function nativeToolNames(platformNames: readonly string[]): string[] {
  return Object.entries(PI_NATIVE_TO_PLATFORM).filter(([, mapped]) => platformNames.includes(mapped)).map(([native]) => native);
}

export interface NativeAdmission {
  name: string;
  args: Record<string, unknown>;
  startedAt: number;
  absolutePath?: string;
  beforeHash?: string | null;
  expectedHash?: string;
}

/** Authorize immediately before the native tool runs, without executing the tool ourselves. */
export async function authorizeNativeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<NativeAdmission> {
  const platformName = PI_NATIVE_TO_PLATFORM[name];
  if (!platformName || !ctx.allowedToolNames?.includes(platformName)) throw new Error("Native tool is not authorized for this Agent.");
  ctx.abortSignal.throwIfAborted();
  const admission: NativeAdmission = { name, args, startedAt: Date.now() };
  if (name === "bash") {
    const allowed = await authorizeBashExecution({ command: args.command, timeoutMs: typeof args.timeout === "number" ? args.timeout * 1000 : undefined }, ctx);
    if (!allowed.ok) throw new Error(allowed.error);
    ctx.abortSignal.throwIfAborted();
    return admission;
  }
  const relative = typeof args.path === "string" ? args.path : ".";
  admission.absolutePath = assertRealPathWithinWorkspace(ctx.workspacePath, relative);
  return admission;
}

/** Pi computes the edit. Its write operation pauses here before any bytes are changed. */
export async function authorizeNativeChange(admission: NativeAdmission, absolutePath: string, proposed: string, ctx: ToolContext): Promise<void> {
  ctx.abortSignal.throwIfAborted();
  if (admission.name !== "write" && admission.name !== "edit") throw new Error("This tool cannot request a file change.");
  if (admission.expectedHash !== undefined) throw new Error("This native change was already authorized.");
  const currentPath = assertRealPathWithinWorkspace(ctx.workspacePath, absolutePath);
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
    assertRealPathWithinWorkspace(ctx.workspacePath, absolutePath);
  }
  ctx.abortSignal.throwIfAborted();
  admission.expectedHash = digest(proposed);
}

export async function captureNativeResult(admission: NativeAdmission, result: unknown, isError: boolean, callId: string, ctx: ToolContext): Promise<ToolResult> {
  const { name, args } = admission;
  const text = nativeResultText(result);
  let normalized: ToolResult = isError ? { ok: false, error: text || "Native Pi tool failed." } : { ok: true, value: { output: text } };
  let evidenceArgs = args;
  if (name === "bash") {
    const value = { command: args.command, cwd: ctx.workspacePath, output: text, exitCode: isError ? null : 0, timedOut: /timed? out/i.test(text) };
    normalized = isError ? { ok: false, error: text, ...{ value } } : { ok: true, value };
    recordCommandEvidence(ctx.runId, { command: String(args.command), cwd: ctx.workspacePath, exitCode: value.exitCode, timedOut: value.timedOut, isError });
  } else if (!isError && admission.absolutePath && (name === "write" || name === "edit")) {
    const absolutePath = assertRealPathWithinWorkspace(ctx.workspacePath, String(args.path));
    const content = fs.readFileSync(absolutePath, "utf8");
    if (digest(content) !== admission.expectedHash) throw new Error("The native tool result does not match the authorized file change.");
    const action = admission.beforeHash === null ? "created" : "modified";
    evidenceArgs = { ...args, path: path.relative(ctx.workspacePath, absolutePath), action };
    normalized = { ok: true, value: { path: evidenceArgs.path, absolutePath, bytes: Buffer.byteLength(content), contentHash: digest(content), applied: "pi-native" } };
    recordFileWrite(ctx.runId, absolutePath, content);
    recordFileWriteEvidence(ctx.runId, { path: String(evidenceArgs.path), absolutePath, action });
  } else if (!isError && name === "read" && admission.absolutePath) {
    const content = fs.readFileSync(admission.absolutePath);
    normalized = { ok: true, value: { content: text, contentHash: createHash("sha256").update(content).digest("hex") } };
  }
  await captureEvidence({ toolName: PI_NATIVE_TO_PLATFORM[name], args: evidenceArgs, result: normalized, context: ctx, durationMs: Date.now() - admission.startedAt, callId });
  return normalized;
}

function digest(content: string): string { return createHash("sha256").update(content).digest("hex"); }

function nativeResultText(result: unknown): string {
  if (!result || typeof result !== "object") return typeof result === "string" ? result : "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: unknown) => block && typeof block === "object" && "text" in block && typeof block.text === "string" ? [block.text] : []).join("\n").slice(0, 100000);
}
