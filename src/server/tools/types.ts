import type { TaskExecutionContract, TaskExecutionIdentity } from "@/shared/evidence-types";

export interface ToolContext {
  conversationId: string;
  workspacePath: string;
  agentId: string;
  runId: string;
  parentRunId?: string | null;
  taskExecution?: TaskExecutionIdentity | null;
  taskContract?: TaskExecutionContract | null;
  abortSignal: AbortSignal;
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
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}
