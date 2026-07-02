import { toolRegistry } from "@/server/tools/registry";
import type { ToolContext } from "@/server/tools/types";

/**
 * Internal MCP bridge — exposes AgentMeld tools to SDK adapters.
 *
 * ClaudeCodeAdapter and CodexAdapter use SDK-native tool sets (Bash, Read, Write, etc.)
 * but need access to AgentMeld-specific tools:
 *   - write_artifact
 *   - read_artifact
 *   - deploy_artifact
 *   - deploy_workspace
 *   - ask_user
 *   - report_task_result
 *
 * These are bridged as MCP tools while the SDK adapters' own tools (Bash/Write/etc.)
 * go through the SDK native path with canUseTool hooks for security.
 */

const BRIDGE_TOOL_NAMES = [
  "write_artifact",
  "read_artifact",
  "deploy_artifact",
  "deploy_workspace",
  "ask_user",
  "report_task_result"
] as const;

export function getBridgeToolNames(): readonly string[] {
  return BRIDGE_TOOL_NAMES;
}

export function isBridgeTool(toolName: string): boolean {
  return (BRIDGE_TOOL_NAMES as readonly string[]).includes(toolName);
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Get MCP tool definitions for SDK adapter registration.
 */
export function getBridgeToolDefs(): McpToolDef[] {
  return BRIDGE_TOOL_NAMES.map((name) => {
    const tool = toolRegistry.get(name);
    if (!tool) return null;
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as Record<string, unknown>
    };
  }).filter(Boolean) as McpToolDef[];
}

/**
 * Execute a bridged tool call from an SDK adapter context.
 */
export async function executeBridgeTool(
  toolName: string,
  args: unknown,
  ctx: ToolContext
): Promise<{ ok: boolean; value: unknown; error?: string }> {
  if (!isBridgeTool(toolName)) {
    return { ok: false, value: null, error: `Tool "${toolName}" is not a bridged tool.` };
  }

  const result = await toolRegistry.execute(toolName, args, ctx);
  if (result.ok) {
    return { ok: true, value: result.value };
  }
  return { ok: false, value: null, error: result.error };
}
