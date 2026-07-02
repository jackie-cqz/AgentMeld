import type { TaskExecutionIdentity } from "@/shared/evidence-types";

export interface ToolContext {
  conversationId: string;
  workspacePath: string;
  agentId: string;
  runId: string;
  parentRunId?: string | null;
  /** P0: task execution identity — set for child runs dispatched by Conductor */
  taskExecution?: TaskExecutionIdentity | null;
  abortSignal: AbortSignal;
}

export type ToolResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}
