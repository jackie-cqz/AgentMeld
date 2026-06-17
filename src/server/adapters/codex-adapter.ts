import type { StreamEvent, AdapterName } from "@/shared/types";
import type { AgentPlatformAdapter, AdapterInput } from "@/server/adapters/types";
import { resolveApiKey, getSettings } from "@/server/settings-service";

/**
 * CodexAdapter — wraps @openai/codex-sdk.
 *
 * Current status: stub.
 * Full implementation requires SDK runStreamed() integration with:
 *   - Streaming Codex events → StreamEvent translation
 *   - Sandbox mode: read-only (review) / workspace-write (auto)
 *   - Isolated CODEX_HOME pointing to Agent-Conference data dir
 *   - Codex base URL validation (must support /responses endpoint)
 *
 * Requires CODEX_API_KEY or OPENAI_API_KEY, or app_settings.
 */
export const codexAdapter: AgentPlatformAdapter = {
  name: "codex" as AdapterName,

  async *run(input: AdapterInput, signal: AbortSignal) {
    const conversationId = input.conversationId;
    const settings = getSettings();
    const apiKey = resolveApiKey("openai", input.agent.apiKey ?? null, settings)
      ?? process.env.CODEX_API_KEY
      ?? null;

    if (!apiKey) {
      yield {
        type: "part.start", conversationId, timestamp: Date.now(),
        messageId: "", partIndex: 0,
        part: { type: "text", content: "" }
      };
      yield {
        type: "part.delta", conversationId, timestamp: Date.now(),
        messageId: "", partIndex: 0,
        delta: { type: "text.append", text: "⚠️ Codex adapter requires an API key. Set CODEX_API_KEY or OPENAI_API_KEY in .env.local, or configure in Settings." }
      };
      yield {
        type: "run.usage", conversationId, timestamp: Date.now(), runId: "",
        usage: { modelId: input.agent.modelId ?? "codex", inputTokens: 0, outputTokens: 0 }
      };
      return;
    }

    // Validate base URL if provided — must support Codex/Responses protocol
    if (input.agent.apiBaseUrl) {
      const baseUrl = input.agent.apiBaseUrl;
      if (baseUrl.includes("deepseek") || baseUrl.includes("chat/completions")) {
        yield {
          type: "part.start", conversationId, timestamp: Date.now(),
          messageId: "", partIndex: 0,
          part: { type: "text", content: "" }
        };
        yield {
          type: "part.delta", conversationId, timestamp: Date.now(),
          messageId: "", partIndex: 0,
          delta: { type: "text.append", text: `⚠️ Codex adapter requires a Codex/Responses-compatible endpoint. The provided base URL (${baseUrl}) does not appear to support the Responses protocol. Use Custom Agent with DeepSeek/OpenAI provider instead.` }
        };
        yield {
          type: "run.usage", conversationId, timestamp: Date.now(), runId: "",
          usage: { modelId: input.agent.modelId ?? "codex", inputTokens: 0, outputTokens: 0 }
        };
        return;
      }
    }

    // Stub: SDK would be initialized here
    yield {
      type: "part.start", conversationId, timestamp: Date.now(),
      messageId: "", partIndex: 0,
      part: { type: "text", content: "" }
    };
    yield {
      type: "part.delta", conversationId, timestamp: Date.now(),
      messageId: "", partIndex: 0,
      delta: { type: "text.append", text: "Codex adapter is initialized but SDK integration is pending (P8 full implementation). Configure Custom Agent with DeepSeek or OpenAI for immediate use." }
    };
    yield {
      type: "run.usage", conversationId, timestamp: Date.now(), runId: "",
      usage: { modelId: input.agent.modelId ?? "codex", inputTokens: 0, outputTokens: 0 }
    };
  }
};
