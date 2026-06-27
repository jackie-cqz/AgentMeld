import type { StreamEvent, AdapterName } from "@/shared/types";
import type { AgentPlatformAdapter, AdapterInput } from "@/server/adapters/types";

/**
 * ClaudeCodeAdapter — wraps @anthropic-ai/claude-agent-sdk.
 *
 * Current status: stub.
 * Full implementation requires SDK query() integration with:
 *   - Streaming assistant text → part.delta events
 *   - SDK tool_use/tool_result → tool.call/tool.result events
 *   - canUseTool hook for path/banned/approval checks
 *   - Session resume via SDK built-in mechanism
 *
 * Key resolution per api-key-management.md §6.2-6.3:
 *   - Uses resolveApiKeyForAgent (adapter-aware: claude-code → anthropic fields)
 *   - When apiBaseUrl is set (third-party gateway), apiKey acts as AUTH_TOKEN
 *     and ANTHROPIC_API_KEY env var must be cleared to prevent override
 */
export const claudeCodeAdapter: AgentPlatformAdapter = {
  name: "claude-code" as AdapterName,

  async *run(input: AdapterInput, _signal: AbortSignal) {
    const conversationId = input.conversationId;

    // This adapter is not yet available for production use.
    // Use Custom Agent with DeepSeek or OpenAI-compatible provider instead.
    yield { type: "part.start", conversationId, timestamp: Date.now(), messageId: "", partIndex: 0, part: { type: "text", content: "" } };
    yield { type: "part.delta", conversationId, timestamp: Date.now(), messageId: "", partIndex: 0, delta: { type: "text.append", text: "Claude Code adapter is not yet available. Please use Custom Agent with DeepSeek or OpenAI-compatible provider." } };
    yield { type: "run.usage", conversationId, timestamp: Date.now(), runId: "", usage: { modelId: input.agent.modelId ?? "claude", inputTokens: 0, outputTokens: 0 } };
    return;
  }
};

// ---------------------------------------------------------------------------
// canUseTool helper — shared with SDK integration
// ---------------------------------------------------------------------------

export interface CanUseToolContext {
  toolName: string;
  toolInput: Record<string, unknown>;
  workspacePath: string;
  agentId: string;
  runId: string;
  signal: AbortSignal;
}

export function canUseTool(ctx: CanUseToolContext): { allowed: boolean; reason?: string } {
  // Path checks for file/Bash tools
  if (ctx.toolName === "Bash" || ctx.toolName === "Write" || ctx.toolName === "Edit" || ctx.toolName === "Read") {
    const targetPath = (ctx.toolInput.file_path || ctx.toolInput.path || "") as string;
    if (targetPath) {
      try {
        assertPathWithinWorkspace(ctx.workspacePath, targetPath);
      } catch {
        return { allowed: false, reason: `Path "${targetPath}" is outside workspace.` };
      }
    }
  }

  // Bash banned pattern check
  if (ctx.toolName === "Bash") {
    const command = (ctx.toolInput.command || "") as string;
    if (command && findBannedPattern(command)) {
      return { allowed: false, reason: `Command blocked by security policy.` };
    }
  }

  return { allowed: true };
}
