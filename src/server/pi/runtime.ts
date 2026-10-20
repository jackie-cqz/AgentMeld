import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { getArtifact } from "@/server/repositories";
import { getTaskReport, recordTaskArtifact } from "@/server/dispatch-task-results";
import { cancelJobsForRun } from "@/server/tools/command-jobs";
import type { DeployStatusRecord } from "@/shared/types";
import { createPiBridge, cancelPiApprovals } from "./bridge";
import { capturePiConfiguration, finishPiExecution, persistPiUsage, preparePiInvocation, updatePiSession } from "./config";
import { PiEventProjection, object } from "./events";
import { PiProcess, PiRuntimeError } from "./process";
import { acquirePiWorkspace, type PiWorkspaceLease } from "./workspace-lease";
import type { PiInvocationInput, PiInvocationStream } from "./types";
import { assertPiAccessProfile } from "./access-profile";
import { registerPiControl } from "./controls";
import { buildPiTaskPacket } from "./packet";

/** No LLM loop lives here: one invocation drives a pinned Pi process to its terminal event. */
export async function* runPiInvocation(input: PiInvocationInput, signal: AbortSignal): PiInvocationStream {
  assertPiAccessProfile(input.accessMode, input.toolNames);
  // Freeze provider resolution before waiting behind another workspace owner.
  input = capturePiConfiguration(input);
  // Pi and its native write callback must use the same physical root as the
  // admission bridge (Windows 8.3 names and directory aliases can differ).
  try { input = { ...input, workspacePath: fs.realpathSync.native(input.workspacePath) }; }
  catch { throw new PiRuntimeError("The Pi workspace directory is not accessible.", "configuration"); }
  const budget = new AbortController();
  const timeoutMs = input.timeoutMs ?? Number(process.env.AGENTMELD_PI_RUN_TIMEOUT_MS ?? 20 * 60 * 1000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 24 * 60 * 60 * 1000) throw new PiRuntimeError("Invalid Pi invocation timeout configuration.", "configuration");
  const deadline = AbortSignal.timeout(timeoutMs);
  const effective = AbortSignal.any([signal, deadline, budget.signal]);
  let lease: PiWorkspaceLease | null = null;
  let execution: ReturnType<typeof preparePiInvocation> | null = null;
  let bridge: Awaited<ReturnType<typeof createPiBridge>> | null = null;
  let child: PiProcess | null = null;
  let completed = false;
  let failure: unknown = null;
  let abortListener: (() => void) | undefined;
  let control: ReturnType<typeof registerPiControl> | undefined;
  const projection = new PiEventProjection(input.conversationId, input.agent.modelId ?? "unknown");
  try {
    effective.throwIfAborted();
    if (input.accessMode !== "conversation") {
      input.onStage?.("queued");
      lease = input.workspaceLease ?? await acquirePiWorkspace(input.workspacePath, effective);
      if (fs.realpathSync.native(lease.workspacePath) !== input.workspacePath) throw new PiRuntimeError("Peer handoff belongs to a different workspace.", "workspace_ownership");
      lease.assertActive();
    }
    input.onStage?.("running");
    execution = preparePiInvocation(input);
    bridge = await createPiBridge(input, effective, () => budget.abort(), lease);
    Object.assign(execution.env, { AGENTMELD_PI_BRIDGE_URL: bridge.url, AGENTMELD_PI_BRIDGE_TOKEN: bridge.token });
    const tools = [...bridge.native, ...bridge.businessNames];
    child = new PiProcess({ cliPath: execution.cliPath, cwd: input.workspacePath, env: execution.env, args: [
      "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
      "--extension", path.join(/*turbopackIgnore: true*/ process.cwd(), "src", "server", "pi", "extension.mjs"),
      // `low|medium|high` is the Agent's configured thinking intensity; unset
      // keeps the previous request (thinking off, no reasoning_effort).
      "--provider", "agentmeld", "--model", input.agent.modelId!, "--thinking", input.agent.reasoningEffort ?? "off",
      "--session-dir", path.join(execution.home, "sessions"), "--tools", tools.length ? tools.join(",") : "",
    ] });
    const ownedChild = child;
    if (child.pid !== undefined) lease?.attachChild(child.pid);
    abortListener = () => {
      cancelPiApprovals(input.runId);
      void ownedChild.close().catch(() => { /* Awaited again by the invocation's finally. */ });
    };
    effective.addEventListener("abort", abortListener, { once: true });
    const state = object((await child.request("get_state")).data);
    if (!bridge.isReady()) throw new PiRuntimeError("The required AgentMeld Pi permission extension did not initialize. No model task was started.", "extension_unavailable");
    if (typeof state?.sessionId !== "string") throw new PiRuntimeError("Pi did not return a native session identity.", "protocol");
    updatePiSession(execution.invocationId, state.sessionId, typeof state.sessionFile === "string" ? state.sessionFile : null);
    control = registerPiControl({ runId: input.runId, signal: effective,
      allowFollowup: input.accessMode === "conversation" && !input.parentRunId && !input.taskExecution && !input.toolNames.includes("respond_to_consultation"),
      request: (kind, params) => ownedChild.request(kind, params),
    });
    const initialPacket = input.prompt ?? buildPiTaskPacket(input);
    input.onContextCaptured?.({ packet: initialPacket, systemPromptHash: createHash("sha256").update(input.systemPrompt).digest("hex"),
      toolNames: [...input.toolNames], accessMode: input.accessMode ?? "workspace" });
    let taskAccepted = false;
    await child.request("prompt", { message: initialPacket });
    const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
    for await (const record of child.events) {
      effective.throwIfAborted();
      control.observe(record);
      const committed = object(record.message);
      if (!taskAccepted && record.type === "message_end" && committed?.role === "user" && Array.isArray(committed.content)) {
        const text = committed.content.map(part => { const block = object(part); return block?.type === "text" && typeof block.text === "string" ? block.text : ""; }).join("");
        if (text === initialPacket) { input.onTaskAccepted?.(); taskAccepted = true; }
      }
      for (const event of projection.consume(record)) yield event;
      if (record.type === "tool_execution_start") {
        if (typeof record.toolCallId !== "string" || typeof record.toolName !== "string") {
          throw new PiRuntimeError("Pi emitted a tool event without a valid identity.", "protocol");
        }
        if (calls.has(record.toolCallId)) throw new PiRuntimeError("Pi reused a tool call ID.", "protocol");
        // Pi also emits these events for validation failures and blocked tools.
        // Only the private bridge can admit an actual execution.
        const args = object(record.args) ?? { rawArguments: record.args ?? null };
        calls.set(record.toolCallId, { name: record.toolName, args });
        yield { type: "tool.call", conversationId: input.conversationId, timestamp: Date.now(), messageId: "", callId: record.toolCallId, toolName: record.toolName, args };
      } else if (record.type === "tool_execution_end") {
        const callId = String(record.toolCallId);
        const call = calls.get(callId);
        if (!call) throw new PiRuntimeError("Pi tool result has no matching call.", "protocol");
        calls.delete(callId);
        const result = bridge.result(callId);
        if (!result && record.isError !== true) throw new PiRuntimeError("Pi claimed tool success without a platform admission receipt.", "protocol");
        const isError = record.isError === true || result?.ok === false;
        yield { type: "tool.result", conversationId: input.conversationId, timestamp: Date.now(), messageId: "", callId,
          result: result ? result.ok ? result.value : result.error : record.result, isError };
        if (result?.ok) {
          const value = object(result.value);
          if (typeof value?.artifactId === "string") {
            if (typeof value.outputKey === "string") recordTaskArtifact(input.runId, value.outputKey, value.artifactId);
            const artifact = getArtifact(value.artifactId);
            if (artifact) yield { type: "artifact.create", conversationId: input.conversationId, timestamp: Date.now(), artifact };
          }
          if ((call.name === "deploy_workspace" || call.name === "deploy_artifact") &&
            typeof value?.id === "string" && typeof value.status === "string") {
            yield { type: "deploy.status", conversationId: input.conversationId, timestamp: Date.now(), messageId: "", deployment: result.value as DeployStatusRecord };
          }
        }
      } else if (record.type === "agent_settled") {
        lease?.assertActive();
        if (calls.size) throw new PiRuntimeError("Pi settled with unfinished tool calls.", "protocol");
        if (!projection.committedAssistantMessages) throw new PiRuntimeError("Pi settled without a committed assistant turn.", "empty_response");
        if (input.parentRunId && !getTaskReport(input.runId)) throw new PiRuntimeError("Pi ended without submitting report_task_result for the delegated task.", "missing_task_report");
        const usage = projection.usage();
        if (usage) yield { type: "run.usage", conversationId: input.conversationId, timestamp: Date.now(), runId: input.runId, usage };
        completed = true;
        break;
      }
    }
    if (!completed) throw new PiRuntimeError("Pi disconnected before the run settled.", "process_exit");
  } catch (error) {
    failure = error;
    if (budget.signal.aborted) throw new PiRuntimeError("Pi task turn budget exhausted.", "turn_limit");
    if (deadline.aborted) throw new PiRuntimeError("Pi invocation timed out.", "timeout");
    if (signal.aborted) throw new PiRuntimeError("Pi invocation was cancelled.", "aborted");
    throw error;
  } finally {
    let controlFailure: unknown = null;
    try { control?.close(); }
    catch (error) { controlFailure = error; failure ??= error; }
    if (abortListener) effective.removeEventListener("abort", abortListener);
    cancelPiApprovals(input.runId);
    const cleanup = await Promise.allSettled([child?.close(), bridge?.close(), cancelJobsForRun(input.runId)]);
    const cleanupFailure = cleanup.find(result => result.status === "rejected");
    if (cleanupFailure?.status === "rejected") {
      try { if (execution) finishPiExecution(execution.invocationId, "failed", "cleanup_failed"); }
      finally { lease?.poison(); }
      // Do not release a workspace if the previous writer may still be alive.
      // eslint-disable-next-line no-unsafe-finally -- Unconfirmed cleanup must override even a successful return.
      throw new PiRuntimeError(cleanupFailure.reason instanceof PiRuntimeError ? cleanupFailure.reason.message : "Pi resource teardown could not be confirmed; workspace remains locked.", "cleanup_failed");
    }
    try {
      if (execution) {
        persistPiUsage(execution.invocationId, projection.usage());
        finishPiExecution(execution.invocationId, signal.aborted ? "aborted" : failure ? "failed" : completed ? "complete" : "interrupted",
          budget.signal.aborted ? "turn_limit" : deadline.aborted ? "timeout" : failure instanceof PiRuntimeError ? failure.category : failure ? "runtime" : null);
      }
    } finally { lease?.release(); }
    // Receipt storage must never skip process/bridge teardown or report a
    // successful run when pending user input could not be settled durably.
    // eslint-disable-next-line no-unsafe-finally -- Propagate only after all cleanup and ownership release.
    if (controlFailure) throw new PiRuntimeError("Pi follow-up receipt could not be settled.", "control_receipt_failed");
  }
}
