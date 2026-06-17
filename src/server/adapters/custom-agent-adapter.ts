import OpenAI from "openai";
import type { AdapterName } from "@/shared/types";
import type { AgentPlatformAdapter, AdapterInput } from "@/server/adapters/types";
import { toolRegistry } from "@/server/tools/registry";
import type { ToolContext } from "@/server/tools/types";
import { getSettings, resolveApiKey } from "@/server/settings-service";

const MAX_TOOL_ROUNDS = 8;

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  "volcano-ark": "https://ark.cn-beijing.volces.com/api/v3"
};

function buildClient(agent: AdapterInput["agent"]): OpenAI {
  const provider = agent.modelProvider ?? "openai";
  const settings = getSettings();
  const apiKey = resolveApiKey(provider, agent.apiKey, settings);

  if (!apiKey) {
    throw new Error(
      `No API key configured for provider "${provider}". ` +
      `Set it in Settings, on the agent, or via the ${provider.toUpperCase()}_API_KEY environment variable.`
    );
  }

  const baseURL = agent.apiBaseUrl || PROVIDER_BASE_URLS[provider];

  return new OpenAI({
    apiKey,
    baseURL: baseURL || undefined
  });
}

export const customAgentAdapter: AgentPlatformAdapter = {
  name: "custom" as AdapterName,

  async *run(input: AdapterInput, signal: AbortSignal) {
    const conversationId = input.conversationId;
    let client: OpenAI;
    try {
      client = buildClient(input.agent);
    } catch (error) {
      // Yield a text error part
      yield {
        type: "part.start",
        conversationId,
        timestamp: Date.now(),
        messageId: "",
        partIndex: 0,
        part: {
          type: "text",
          content: `⚠️ ${error instanceof Error ? error.message : "Failed to build API client."}`
        }
      };
      yield {
        type: "run.usage",
        conversationId,
        timestamp: Date.now(),
        runId: "",
        usage: { modelId: input.agent.modelId ?? "unknown", inputTokens: 0, outputTokens: 0 }
      };
      return;
    }

    const model = input.agent.modelId || "gpt-4.1-mini";

    // Build tools
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
    if (input.toolNames.length > 0) {
      const resolved = toolRegistry.resolve(input.toolNames);
      for (const tool of resolved) {
        tools.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as Record<string, unknown>
          }
        });
      }
    }

    // Build messages
    const messages = buildMessages(input);

    // Tool loop
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let partIndex = 0;

    let currentMessages = [...messages];
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) break;

      let stream: Awaited<ReturnType<typeof client.chat.completions.create>>;
      try {
        stream = await client.chat.completions.create({
          model,
          messages: currentMessages,
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
          stream_options: { include_usage: true }
        });
      } catch (err: unknown) {
        const errorText = formatApiError(err, model);
        if (round === 0) {
          // First round error — show directly as message part
          yield { type: "part.start", conversationId, timestamp: Date.now(), messageId: "", partIndex, part: { type: "text", content: "" } };
          yield { type: "part.delta", conversationId, timestamp: Date.now(), messageId: "", partIndex, delta: { type: "text.append", text: errorText } };
          yield { type: "part.end", conversationId, timestamp: Date.now(), messageId: "", partIndex };
        }
        yield { type: "run.usage", conversationId, timestamp: Date.now(), runId: "", usage: { modelId: model, inputTokens: totalInputTokens, outputTokens: totalOutputTokens } };
        return;
      }

      // Accumulate deltas
      let textContent = "";
      let thinkingContent = "";
      const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
      let hasToolCalls = false;
      let textPartStarted = false;
      let thinkingPartStarted = false;
      const currentTextPartIndex = partIndex;
      const currentThinkingPartIndex = thinkingPartStarted ? partIndex + (textPartStarted ? 1 : 0) : -1;

      for await (const chunk of stream) {
        if (signal.aborted) break;

        // Track usage
        if (chunk.usage) {
          totalInputTokens += chunk.usage.prompt_tokens || 0;
          totalOutputTokens += chunk.usage.completion_tokens || 0;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Text content
        if (delta.content) {
          if (!textPartStarted) {
            textPartStarted = true;
            yield {
              type: "part.start",
              conversationId,
              timestamp: Date.now(),
              messageId: "",
              partIndex: currentTextPartIndex,
              part: { type: "text", content: "" }
            };
          }
          textContent += delta.content;
          yield {
            type: "part.delta",
            conversationId,
            timestamp: Date.now(),
            messageId: "",
            partIndex: currentTextPartIndex,
            delta: { type: "text.append", text: delta.content }
          };
        }

        // Reasoning / thinking (DeepSeek)
        const reasoning = (delta as Record<string, unknown>).reasoning_content as string | undefined;
        if (reasoning) {
          if (!thinkingPartStarted) {
            thinkingPartStarted = true;
            const thinkingIdx = textPartStarted ? currentTextPartIndex + 1 : currentTextPartIndex;
            yield {
              type: "part.start",
              conversationId,
              timestamp: Date.now(),
              messageId: "",
              partIndex: thinkingIdx,
              part: { type: "thinking", content: "" }
            };
          }
          thinkingContent += reasoning;
          yield {
            type: "part.delta",
            conversationId,
            timestamp: Date.now(),
            messageId: "",
            partIndex: currentThinkingPartIndex >= 0 ? currentThinkingPartIndex : (textPartStarted ? currentTextPartIndex + 1 : currentTextPartIndex),
            delta: { type: "thinking.append", text: reasoning }
          };
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index;
            if (!toolCalls.has(index)) {
              toolCalls.set(index, {
                id: tc.id || "",
                name: tc.function?.name || "",
                args: tc.function?.arguments || ""
              });
            } else {
              const existing = toolCalls.get(index)!;
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) existing.args += tc.function.arguments;
            }
          }
          hasToolCalls = true;
        }
      }

      // End text/thinking parts
      if (textPartStarted) {
        yield { type: "part.end", conversationId, timestamp: Date.now(), messageId: "", partIndex: currentTextPartIndex };
        partIndex = currentTextPartIndex + 1;
      }
      if (thinkingPartStarted) {
        const ti = textPartStarted ? currentTextPartIndex + 1 : currentTextPartIndex;
        yield { type: "part.end", conversationId, timestamp: Date.now(), messageId: "", partIndex: ti };
        partIndex = ti + 1;
      }

      if (signal.aborted) break;

      // If no tool calls, we're done
      if (!hasToolCalls || toolCalls.size === 0) {
        break;
      }

      // Execute tool calls
      const toolResults: Array<{ callId: string; name: string; result: unknown; isError: boolean }> = [];
      const ctx: ToolContext = {
        conversationId,
        workspacePath: input.workspace.mode === "local" && input.workspace.boundPath
          ? input.workspace.boundPath
          : input.workspace.rootPath,
        agentId: input.agent.id,
        runId: input.runId,
        abortSignal: signal
      };

      for (const [, tc] of toolCalls) {
        let args: unknown;
        try {
          args = JSON.parse(tc.args || "{}");
        } catch {
          args = {};
        }

        yield {
          type: "tool.call",
          conversationId,
          timestamp: Date.now(),
          messageId: "",
          callId: tc.id,
          toolName: tc.name,
          args
        };

        const result = await toolRegistry.execute(tc.name, args, ctx);

        yield {
          type: "tool.result",
          conversationId,
          timestamp: Date.now(),
          messageId: "",
          callId: tc.id,
          result: result.ok ? result.value : result.error,
          isError: !result.ok
        };

        toolResults.push({
          callId: tc.id,
          name: tc.name,
          result: result.ok ? result.value : result.error,
          isError: !result.ok
        });

        // If tool created an artifact, emit artifact.create
        if (result.ok && typeof result.value === "object" && result.value !== null) {
          const val = result.value as Record<string, unknown>;
          if (typeof val.artifactId === "string" && tc.name === "write_artifact") {
            yield {
              type: "artifact.create",
              conversationId,
              timestamp: Date.now(),
              artifact: {
                id: val.artifactId as string,
                conversationId,
                createdByAgentId: input.agent.id,
                type: (val.type as never) || "document",
                title: (val.title as string) || "Untitled",
                content: (val as never),
                version: 1,
                parentArtifactId: null,
                createdAt: Date.now(),
                updatedAt: Date.now()
              }
            };
          }
        }
      }

      // Add assistant message + tool results to conversation
      const assistantMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
        role: "assistant",
        content: textContent || null,
        tool_calls: Array.from(toolCalls.entries()).map(([, tc]) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.args }
        }))
      };

      const toolMsgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = toolResults.map((tr) => ({
        role: "tool",
        tool_call_id: tr.callId,
        content: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result)
      }));

      currentMessages = [...currentMessages, assistantMsg, ...toolMsgs];
      partIndex++;
    }

    // Yield final usage
    yield {
      type: "run.usage",
      conversationId,
      timestamp: Date.now(),
      runId: "",
      usage: {
        modelId: model,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens
      }
    };
  }
};

function buildMessages(input: AdapterInput): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  // System prompt with workspace info (already composed by AgentRunner)
  messages.push({ role: "system", content: input.systemPrompt });

  // Cross-run history (from conversation-context service)
  if (input.history && input.history.length > 0) {
    for (const h of input.history) {
      messages.push({ role: h.role as "user" | "assistant" | "system", content: h.content });
    }
  }

  // Current trigger message
  const triggerText = input.triggerMessage.parts
    .filter((p) => p.type === "text")
    .map((p) => p.content)
    .join("\n");
  messages.push({ role: "user", content: triggerText });

  return messages;
}

function formatApiError(err: unknown, model: string): string {
  if (err instanceof Error) {
    const msg = err.message;
    // OpenAI SDK wraps HTTP errors with status code in message
    if (msg.includes("401")) {
      return `⚠️ API Key 无效（401）。请在 Settings → DeepSeek API Key 中检查 Key 是否正确，或确认 Key 是否已过期。`;
    }
    if (msg.includes("403")) {
      return `⚠️ 访问被拒绝（403）。API Key 可能没有权限访问模型 "${model}"，或账户余额不足。请检查 DeepSeek 控制台。`;
    }
    if (msg.includes("429")) {
      return `⚠️ API 请求频率过高（429）。DeepSeek 限流，请稍后重试。`;
    }
    if (msg.includes("500") || msg.includes("502") || msg.includes("503")) {
      return `⚠️ DeepSeek 服务端错误（5xx）。服务器暂时不可用，请稍后重试。`;
    }
    if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("ECONNREFUSED")) {
      return `⚠️ 连接 DeepSeek API 超时。请检查网络连接，或确认 API Base URL 配置正确。`;
    }
    return `⚠️ API 调用失败：${msg.slice(0, 200)}`;
  }
  return `⚠️ API 调用失败：未知错误。`;
}
