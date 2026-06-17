import { newArtifactId } from "@/shared/ids";
import type { Artifact, MessagePart, StreamEvent } from "@/shared/types";
import type { AgentPlatformAdapter, AdapterInput } from "@/server/adapters/types";

const THINKING_CONTENT = "我先快速判断任务意图、相关上下文和下一步交付物。";

function buildReply(input: AdapterInput): string {
  const text = extractPlainText(input.triggerMessage.parts);
  const agent = input.agent;

  if (agent.isOrchestrator) {
    return [
      `我已收到任务："${text || "继续推进 MVP"}"。`,
      "MVP 第一阶段会先把会话、消息、Agent 运行和事件流串起来，保持适配器层可替换。",
      "当前我会让前端工程师补齐界面与交互，并把产物预览留成下一步可插拔面板。"
    ].join("\n");
  }

  if (agent.name.includes("前端")) {
    return [
      "我会按预览图落三栏结构：左侧会话与 Agent 入口，中间群聊消息流，右侧预留 Artifact 面板。",
      "组件先拆成 Sidebar、ChatPanel、Composer、MessageParts 和 ArtifactPanel，确保后续接真实运行事件时不用推翻 UI。"
    ].join("\n");
  }

  return [
    "我会把需求整理成可执行清单：核心闭环优先于复杂工具，先让用户能创建会话、发送消息、看到多 Agent 协作反馈。",
    "后续再补 workspace 权限、真实工具调用、Artifact 版本和对比。"
  ].join("\n");
}

function maybeCreateArtifact(input: AdapterInput): Artifact | null {
  if (!input.agent.name.includes("前端")) return null;

  const now = Date.now();
  return {
    id: newArtifactId(),
    conversationId: input.conversationId,
    createdByAgentId: input.agent.id,
    type: "document",
    title: "MVP UI 组件拆分草案",
    content: {
      type: "document",
      format: "markdown",
      content: [
        "# MVP UI 组件拆分草案",
        "",
        "- Sidebar: 会话列表、搜索、新建会话、Agent 入口",
        "- ChatPanel: 消息流、运行状态、Composer",
        "- MessageParts: text / thinking / code / artifact_ref 渲染",
        "- ArtifactPanel: 预览、版本、编辑入口"
      ].join("\n")
    },
    version: 1,
    parentArtifactId: null,
    createdAt: now,
    updatedAt: now
  };
}

export const mockAdapter: AgentPlatformAdapter = {
  name: "mock",

  async *run(input: AdapterInput, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const conversationId = input.conversationId;

    // -- thinking part --
    yield {
      type: "part.start",
      conversationId,
      timestamp: Date.now(),
      messageId: "", // placeholder, AgentRunner fills
      partIndex: 0,
      part: { type: "thinking", content: "" }
    };

    for (const chunk of chunkText(THINKING_CONTENT, 18)) {
      if (signal.aborted) return;
      await delay(60);
      yield {
        type: "part.delta",
        conversationId,
        timestamp: Date.now(),
        messageId: "",
        partIndex: 0,
        delta: { type: "thinking.append", text: chunk }
      };
    }

    yield {
      type: "part.end",
      conversationId,
      timestamp: Date.now(),
      messageId: "",
      partIndex: 0
    };

    // -- text part --
    const reply = buildReply(input);
    yield {
      type: "part.start",
      conversationId,
      timestamp: Date.now(),
      messageId: "",
      partIndex: 1,
      part: { type: "text", content: "" }
    };

    for (const chunk of chunkText(reply, 20)) {
      if (signal.aborted) return;
      await delay(50);
      yield {
        type: "part.delta",
        conversationId,
        timestamp: Date.now(),
        messageId: "",
        partIndex: 1,
        delta: { type: "text.append", text: chunk }
      };
    }

    yield {
      type: "part.end",
      conversationId,
      timestamp: Date.now(),
      messageId: "",
      partIndex: 1
    };

    // -- tool call --
    const toolCallId = "call_mock_demo";
    yield {
      type: "tool.call",
      conversationId,
      timestamp: Date.now(),
      messageId: "",
      callId: toolCallId,
      toolName: "read_artifact",
      args: { artifactId: "art_demo_placeholder" }
    };

    await delay(100);

    yield {
      type: "tool.result",
      conversationId,
      timestamp: Date.now(),
      messageId: "",
      callId: toolCallId,
      result: {
        id: "art_demo_placeholder",
        type: "document",
        title: "示例产物",
        content: { type: "document", content: "# Mock 产物\n\n这是一个由 MockAdapter 生成的示例产物。" },
        version: 1
      },
      isError: false
    };

    // -- artifact --
    const artifact = maybeCreateArtifact(input);
    if (artifact) {
      await delay(80);
      yield {
        type: "artifact.create",
        conversationId,
        timestamp: Date.now(),
        artifact
      };
    }

    // -- usage --
    yield {
      type: "run.usage",
      conversationId,
      timestamp: Date.now(),
      runId: "",
      usage: {
        modelId: input.agent.modelId ?? "mock",
        inputTokens: 120,
        outputTokens: 180
      }
    };
  }
};

function extractPlainText(parts: MessagePart[]) {
  return parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.content)
    .join("\n")
    .trim();
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
