import type { StreamEvent, AdapterName } from "@/shared/types";
import type { AgentPlatformAdapter, AdapterInput } from "@/server/adapters/types";

/**
 * CodexAdapter — wraps @openai/codex-sdk.
 *
 * Current status: stub.
 * Full implementation requires SDK runStreamed() integration with:
 *   - Streaming Codex events → StreamEvent translation
 *   - Sandbox mode: read-only (review) / workspace-write (auto)
 *   - Isolated CODEX_HOME pointing to AgentMeld data dir
 *   - Codex base URL validation (must support /responses endpoint)
 *
 * Key resolution per api-key-management.md §6.2 + §6.4:
 *   - Uses resolveApiKeyForAgent (adapter-aware: codex → openai fields)
 *   - Extra fallback: CODEX_API_KEY env var
 *   - CODEX_HOME and CODEX_SQLITE_HOME must point to isolated directories
 *     to prevent external Codex config from affecting AgentMeld
 */
export const codexAdapter: AgentPlatformAdapter = {
  name: "codex" as AdapterName,

  async *run(input: AdapterInput, _signal: AbortSignal) {
    const conversationId = input.conversationId;

    // This adapter is not yet available for production use.
    // Use Custom Agent with DeepSeek or OpenAI-compatible provider instead.
    yield { type: "part.start", conversationId, timestamp: Date.now(), messageId: "", partIndex: 0, part: { type: "text", content: "" } };
    yield { type: "part.delta", conversationId, timestamp: Date.now(), messageId: "", partIndex: 0, delta: { type: "text.append", text: "Codex adapter is not yet available. Please use Custom Agent with DeepSeek or OpenAI-compatible provider." } };
    yield { type: "run.usage", conversationId, timestamp: Date.now(), runId: "", usage: { modelId: input.agent.modelId ?? "codex", inputTokens: 0, outputTokens: 0 } };
    return;
  }
};
