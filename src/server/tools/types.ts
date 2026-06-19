export interface ToolContext {
  conversationId: string;
  workspacePath: string;
  agentId: string;
  runId: string;
  parentRunId?: string | null;
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
