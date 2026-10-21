import { toolRegistry } from "@/server/tools/registry";
import type { ToolContext, ToolResult } from "@/server/tools/types";
import type { TaskExecutionContract, TaskExecutionIdentity } from "@/shared/evidence-types";
import { cancelPendingBashForRun } from "@/server/pending-bash";
import { cancelPendingWritesForRun } from "@/server/pending-writes";
import { cancelPendingQuestionsForRun } from "@/server/pending-questions";
import { cancelPendingPlansForRun } from "@/server/dispatch-plan-manager";
import { recordTaskArtifact } from "@/server/dispatch-task-results";
import { assertHarnessAccessProfile } from "./tool-surface";
import {
  authorizeNativeChange,
  authorizeNativeTool,
  captureNativeResult,
  isNativeWorkspaceTool,
  NATIVE_WORKSPACE_TOOLS,
  type HarnessNativeCall,
  type HarnessNativeOutcome,
  type NativeAdmission,
} from "./native-tools";
import type { HarnessAccessMode, HarnessWorkspaceLease, LendableWorkspaceLease } from "./types";

/**
 * The harness-neutral tool bridge (#25 P2).
 *
 * This is the platform half of "the Agent can call tools": the business-tool
 * catalogue with its JSON schemas, platform admission, approvals, evidence,
 * call-id replay protection, terminal-tool gating and the workspace-ownership
 * pause during a peer consultation. It owns no transport. Pi reaches it through
 * its loopback HTTP server (`src/server/pi/bridge.ts`) and a second in-process
 * driver reaches it directly; both get the same result and evidence semantics.
 *
 * Names crossing this boundary are PLATFORM names (`fs_read`, `write_artifact`,
 * …). A driver maps its own native vocabulary onto them; the bridge never learns
 * an engine's tool names, JSON-RPC framing, token or extension manifest.
 *
 * Deliberately absent: Pi's turn budget, its manifest/system-prompt rewrite,
 * result-text extraction from its native result shape and its tool-name map.
 * Those are transport/engine concerns and stay beside the engine.
 */

/** Tools whose accepted result ends the invocation's tool activity. */
const TERMINAL_PLATFORM_TOOLS: readonly string[] = ["plan_tasks", "report_task_result", "respond_to_consultation"];

/** One platform business tool an invocation may call, with its JSON schema. */
export interface HarnessToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Why the bridge refused to admit a call at all (as opposed to a tool that ran
 * and failed). A transport may map these to its own status/error shape — Pi uses
 * `not_provisioned` for HTTP 403 and everything else for HTTP 400.
 */
export type HarnessToolBridgeRejection = "not_provisioned" | "rejected";

export class HarnessToolBridgeError extends Error {
  constructor(message: string, readonly reason: HarnessToolBridgeRejection) {
    super(message);
    this.name = "HarnessToolBridgeError";
  }
}

export interface HarnessToolBridgeInput {
  // --- identity ---------------------------------------------------------
  conversationId: string;
  agentId: string;
  runId: string;
  parentRunId?: string | null;
  taskExecution?: TaskExecutionIdentity | null;
  taskContract?: TaskExecutionContract | null;
  workspacePath: string;

  /** The cancelled/aborted signal this invocation runs under. */
  signal: AbortSignal;

  /** PLATFORM tool names this invocation is provisioned with. */
  toolNames: readonly string[];

  /**
   * The platform workspace lease this invocation holds, when it owns the
   * workspace. The bridge lends it for `consult_agent`; a driver never has to
   * implement lending.
   */
  lease?: LendableWorkspaceLease | null;

  /** Engine id recorded in execution metadata and evidence provenance (e.g. "pi"). */
  source: string;
  /** Human-facing engine name used in budget messages (e.g. "Pi"). Defaults to `source`. */
  engineLabel?: string;
  /** Fallback text for a failed native call that produced no message. */
  nativeFailureMessage?: string;

  /** Defaults to `"workspace"`. */
  access?: HarnessAccessMode;
}

export interface HarnessToolBridge {
  /** Business tools this invocation may call, with the platform's JSON schemas. */
  readonly catalogue: HarnessToolDefinition[];
  /** PLATFORM names of the workspace tools this engine implements natively. */
  readonly nativeTools: string[];
  /** PLATFORM names of the business tools this invocation may call. */
  readonly businessTools: string[];

  /**
   * Invoke one provisioned business tool. Returns the platform `ToolResult` for
   * a tool that ran (success or failure); throws `HarnessToolBridgeError` when
   * the call itself is refused (unprovisioned, replayed, paused, after a terminal
   * result, or over the call budget).
   */
  invoke(toolName: string, args: unknown, callId: string): Promise<ToolResult>;

  /**
   * Admit one native call before the engine runs it. Throws on refusal and
   * records the refusal as preflight evidence, as the Pi bridge always has.
   */
  beginNative(call: HarnessNativeCall): Promise<NativeAdmission>;

  /** The engine is about to write bytes; approvals/quota/integrity run here. */
  authorizeNativeChange(callId: string, absolutePath: string, proposed: string): Promise<void>;

  /** Record the engine's native outcome; returns the platform-shaped result. */
  completeNative(callId: string, outcome: HarnessNativeOutcome): Promise<ToolResult>;

  /** The platform result for an already-consumed call id, once it exists. */
  result(callId: string): ToolResult | undefined;

  /** Stop admitting calls and settle the platform-side approval bookkeeping. */
  close(): Promise<void>;
}

/**
 * Cancel every approval this run has pending. Platform-owned: any engine's run
 * may have asked a human for a write/command/question/plan decision, and all of
 * them must be withdrawn when the run stops.
 */
export function cancelPendingApprovalsForRun(runId: string): void {
  cancelPendingBashForRun(runId);
  cancelPendingWritesForRun(runId);
  cancelPendingQuestionsForRun(runId);
  cancelPendingPlansForRun(runId);
}

export function createHarnessToolBridge(input: HarnessToolBridgeInput): HarnessToolBridge {
  assertHarnessAccessProfile(input.access, input.toolNames);
  const source = input.source;
  const engineLabel = input.engineLabel ?? input.source;
  const failureMessage = input.nativeFailureMessage ?? "Native tool failed.";
  const lease = input.lease ?? null;
  const ctx: ToolContext = {
    conversationId: input.conversationId,
    agentId: input.agentId,
    runId: input.runId,
    parentRunId: input.parentRunId,
    workspacePath: input.workspacePath,
    taskExecution: input.taskExecution,
    taskContract: input.taskContract,
    abortSignal: input.signal,
  };
  // `toolNames` is what this invocation is PROVISIONED with, not a permission
  // decision: an Agent run is provisioned with the whole workspace toolset, while
  // platform-internal phases such as the Conductor's PLAN stage deliberately
  // scope their own surface.
  const nativeTools = NATIVE_WORKSPACE_TOOLS.filter(name => input.toolNames.includes(name));
  const businessTools = input.toolNames.filter(name => !isNativeWorkspaceTool(name));
  const catalogue = toolRegistry.resolve(businessTools).map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.parameters),
  }));

  const results = new Map<string, ToolResult>();
  const admissions = new Map<string, NativeAdmission>();
  const admittedCalls = new Set<string>();
  let closed = false;
  let terminalToolAccepted = false;
  let consultationActive = false;
  let activeBusinessCalls = 0;
  let activeNativeAdmissions = 0;

  const admitCall = (callId: string) => {
    if (closed) throw new HarnessToolBridgeError("The tool bridge is closed.", "rejected");
    input.signal.throwIfAborted();
    if (consultationActive) throw new HarnessToolBridgeError("This invocation is waiting for its peer; tools resume after the peer has stopped.", "rejected");
    lease?.assertActive();
    if (terminalToolAccepted) throw new HarnessToolBridgeError("This invocation already submitted its terminal platform result.", "rejected");
    if (admittedCalls.size >= 512) throw new HarnessToolBridgeError(`${engineLabel} tool call budget exhausted.`, "rejected");
    if (admittedCalls.has(callId)) throw new HarnessToolBridgeError("Tool call ID has already been consumed.", "rejected");
    admittedCalls.add(callId);
  };

  const onAbort = () => cancelPendingApprovalsForRun(input.runId);
  input.signal.addEventListener("abort", onAbort, { once: true });

  return {
    catalogue,
    nativeTools,
    businessTools,

    async invoke(toolName, args, callId) {
      admitCall(callId);
      if (!businessTools.includes(toolName)) {
        throw new HarnessToolBridgeError("Tool is not authorized for this invocation.", "not_provisioned");
      }
      let result: ToolResult;
      if (toolName === "consult_agent") {
        // A peer runs in this same workspace: nothing else may be mid-flight when
        // ownership is handed over, and the source pauses until the peer stops.
        if (admissions.size || activeNativeAdmissions || activeBusinessCalls) {
          throw new HarnessToolBridgeError("Finish other tool calls before handing the workspace to a peer.", "rejected");
        }
        consultationActive = true;
        try {
          const execute = (consultationLease?: HarnessWorkspaceLease) =>
            toolRegistry.execute(toolName, args, { ...ctx, consultationLease }, { callId, source });
          result = lease ? await lease.lend(execute) : await execute();
        } finally { consultationActive = false; }
      } else {
        activeBusinessCalls++;
        try { result = await toolRegistry.execute(toolName, args, ctx, { callId, source }); }
        finally { activeBusinessCalls--; }
      }
      if (result.ok && result.value && typeof result.value === "object") {
        const value = result.value as Record<string, unknown>;
        if (typeof value.artifactId === "string" && typeof value.outputKey === "string") {
          // Bind before the engine can submit its terminal report; stdout projection may lag.
          recordTaskArtifact(input.runId, value.outputKey, value.artifactId);
        }
      }
      results.set(callId, result);
      if (result.ok && TERMINAL_PLATFORM_TOOLS.includes(toolName)) terminalToolAccepted = true;
      return result;
    },

    async beginNative(call) {
      admitCall(call.callId);
      activeNativeAdmissions++;
      try {
        if (!isNativeWorkspaceTool(call.name) || !nativeTools.includes(call.name)) {
          throw new HarnessToolBridgeError("Native tool is not provisioned for this internal invocation.", "rejected");
        }
        const admission = await authorizeNativeTool(call, ctx);
        admissions.set(call.callId, admission);
        input.signal.throwIfAborted();
        return admission;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Native tool admission failed.";
        const result = await toolRegistry.recordPreflightFailure(call.name, call.args, message, ctx,
          { callId: call.callId, source: "system" }, { code: `${source.toUpperCase()}_NATIVE_TOOL_REJECTED`, category: "security_policy" });
        results.set(call.callId, result);
        throw error;
      } finally { activeNativeAdmissions--; }
    },

    async authorizeNativeChange(callId, absolutePath, proposed) {
      const admission = admissions.get(callId);
      if (!admission) throw new HarnessToolBridgeError("Native change has no matching admitted call.", "rejected");
      await authorizeNativeChange(admission, absolutePath, proposed, ctx);
    },

    async completeNative(callId, outcome) {
      const admission = admissions.get(callId);
      if (!admission) throw new HarnessToolBridgeError("Native result has no matching admitted call.", "rejected");
      admissions.delete(callId);
      const result = await captureNativeResult(admission, outcome, ctx, { source, failureMessage });
      results.set(callId, result);
      return result;
    },

    result(callId) { return results.get(callId); },

    async close() {
      closed = true;
      input.signal.removeEventListener("abort", onAbort);
      cancelPendingApprovalsForRun(input.runId);
      results.clear();
      admissions.clear();
    },
  };
}
