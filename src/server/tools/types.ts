import type { TaskExecutionContract, TaskExecutionIdentity } from "@/shared/evidence-types";
import type { ToolCapability } from "@/server/tools/capabilities";

export interface ToolContext {
  conversationId: string;
  workspacePath: string;
  agentId: string;
  runId: string;
  parentRunId?: string | null;
  taskExecution?: TaskExecutionIdentity | null;
  taskContract?: TaskExecutionContract | null;
  abortSignal: AbortSignal;
  allowedToolNames?: readonly string[];
}

export type ToolFailureCategory =
  | "security_policy"
  | "approval_rejected"
  | "validation_error"
  | "tool_error";

export interface ToolExecutionMeta {
  /** Stable ID from the model/MCP tool call. */
  callId: string;
  source?: "llm" | "mcp" | "system" | "benchmark";
}

export type ToolResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: string;
      /** Stable machine-readable failure code; UI text must not be parsed when this exists. */
      code?: string;
      category?: ToolFailureCategory;
    };

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * What this tool can reach, declared once and used to describe the workspace
   * honestly (see tools/capabilities.ts). Required: the registry test fails if
   * a tool omits it, because a prompt that overstates confinement is how an
   * agent ends up treating the host as a sandbox.
   */
  capabilities: readonly ToolCapability[];
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}
