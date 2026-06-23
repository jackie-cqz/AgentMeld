import type { Agent, StreamEvent, AdapterName } from "@/shared/types";
import type { AgentPlatformAdapter, AdapterInput } from "@/server/adapters/types";
import { resolveApiKeyForAgent, resolveApiBaseUrl, getSettings } from "@/server/settings-service";
import { findBannedPattern } from "@/server/security";
import { assertPathWithinWorkspace } from "@/server/workspace-utils";

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

  async *run(input: AdapterInput, signal: AbortSignal) {
    const conversationId = input.conversationId;
    const settings = getSettings();
    const apiKey = resolveApiKeyForAgent(
      { adapterName: "claude-code", modelProvider: "anthropic", apiKey: input.agent.apiKey },
      settings
    );
    const effectiveBaseUrl = input.apiBaseUrl ?? resolveApiBaseUrl(
      { adapterName: "claude-code", apiBaseUrl: input.agent.apiBaseUrl },
      settings
    );

    if (!apiKey) {
      yield {
        type: "part.start", conversationId, timestamp: Date.now(),
        messageId: "", partIndex: 0,
        part: { type: "text", content: "" }
      };
      yield {
        type: "part.delta", conversationId, timestamp: Date.now(),
        messageId: "", partIndex: 0,
        delta: { type: "text.append", text: "⚠️ Claude Code adapter requires an Anthropic API key. Set it in Settings → Anthropic API Key, or set ANTHROPIC_API_KEY in .env.local." }
      };
      yield {
        type: "run.usage", conversationId, timestamp: Date.now(), runId: "",
        usage: { modelId: input.agent.modelId ?? "claude", inputTokens: 0, outputTokens: 0 }
      };
      return;
    }

    // Per §6.3: When a custom base URL is configured (third-party gateway),
    // the apiKey becomes ANTHROPIC_AUTH_TOKEN. Clear ANTHROPIC_API_KEY to
    // prevent the env var from overriding the gateway's auth header.
    const isGateway = !!effectiveBaseUrl;
    if (isGateway) {
      // When full SDK integration lands:
      //   process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
      //   process.env.ANTHROPIC_BASE_URL = effectiveBaseUrl;
      //   delete process.env.ANTHROPIC_API_KEY;
    }

    // Stub: SDK would be initialized here
    // const query = client.query({ prompt: buildClaudePrompt(input), options: { ... } });

    // Yield a placeholder message for now
    yield {
      type: "part.start", conversationId, timestamp: Date.now(),
      messageId: "", partIndex: 0,
      part: { type: "text", content: "" }
    };
    yield {
      type: "part.delta", conversationId, timestamp: Date.now(),
      messageId: "", partIndex: 0,
      delta: { type: "text.append", text: "Claude Code adapter is initialized but SDK integration is pending (P8 full implementation). Configure Custom Agent with DeepSeek or OpenAI for immediate use." }
    };
    yield {
      type: "run.usage", conversationId, timestamp: Date.now(), runId: "",
      usage: { modelId: input.agent.modelId ?? "claude", inputTokens: 0, outputTokens: 0 }
    };
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
