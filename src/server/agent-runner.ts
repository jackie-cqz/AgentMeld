import { ensureDatabase } from "@/db/bootstrap";
import { getAdapter } from "@/server/adapters/registry";
import type { AdapterInput } from "@/server/adapters/types";
import { eventBus } from "@/server/event-bus";
import {
  createArtifact,
  createMessage,
  createRun,
  getAgent,
  getArtifact,
  getConversation,
  getWorkspaceForConversation,
  listMessages,
  updateMessageParts,
  updateMessageStatus,
  updateRunStatus
} from "@/server/repositories";
import { buildHistoryFor } from "@/server/conversation-context";
import { executeOrchestrator } from "@/server/orchestrator-service";
import { resolveApiKey, getSettings } from "@/server/settings-service";
import { estimateTokens } from "@/shared/token-estimate";
import { getModelLimits } from "@/shared/model-registry";
import { newMessageId, newRunId } from "@/shared/ids";
import type { Agent, AgentRun, Conversation, Message, StreamEvent } from "@/shared/types";
import type { ChatMessage } from "@/server/conversation-context";

// ---------------------------------------------------------------------------
// In-memory abort map — not persisted, dev-server restart clears it.
// ---------------------------------------------------------------------------

const activeRuns = new Map<string, AbortController>();

export function abortRun(runId: string): boolean {
  const controller = activeRuns.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

// ---------------------------------------------------------------------------
// Public entry point — called from conversation-service.sendMessage()
// ---------------------------------------------------------------------------

interface StartRunInput {
  conversationId: string;
  agentId: string;
  triggerMessage: Message;
  runId?: string;
  parentRunId?: string | null;
}

export interface RunHandle {
  runId: string;
  promise: Promise<void>;
}

export function startAgentRun(input: StartRunInput): RunHandle {
  const runId = input.runId ?? newRunId();
  const promise = executeRun({ ...input, runId }).catch((error: unknown) => {
    console.error("Agent run failed", error);
  });
  return { runId, promise };
}

// ---------------------------------------------------------------------------
// Core run loop
// ---------------------------------------------------------------------------

interface ExecuteRunInput extends StartRunInput {
  runId: string;
}

async function executeRun(input: ExecuteRunInput): Promise<void> {
  ensureDatabase();

  // 1. Look up entities
  const agent = getAgent(input.agentId);
  if (!agent) {
    createErrorMessage(input.conversationId, input.triggerMessage.id, `Agent "${input.agentId}" not found.`);
    return;
  }

  const conversation = getConversation(input.conversationId);
  if (!conversation) {
    createErrorMessage(input.conversationId, input.triggerMessage.id, "Conversation not found.");
    return;
  }

  const workspace = getWorkspaceForConversation(input.conversationId);
  if (!workspace) {
    createErrorMessage(input.conversationId, input.triggerMessage.id, "Workspace not found.");
    return;
  }

  // 2. Create run record
  const now = Date.now();
  const run: AgentRun = createRun({
    id: input.runId,
    conversationId: input.conversationId,
    agentId: input.agentId,
    triggerMessageId: input.triggerMessage.id,
    status: "running",
    now
  });

  // 3. Abort controller
  const abortController = new AbortController();
  activeRuns.set(run.id, abortController);

  // 4. Publish run.start
  eventBus.publish({
    type: "run.start",
    conversationId: input.conversationId,
    timestamp: now,
    runId: run.id,
    agentId: run.agentId,
    triggerMessageId: run.triggerMessageId,
    parentRunId: run.parentRunId
  });

  // 5. Create agent response message
  let message = createMessage({
    id: newMessageId(),
    conversationId: input.conversationId,
    role: "agent",
    agentId: input.agentId,
    runId: run.id,
    parts: [],
    status: "streaming",
    now
  });

  eventBus.publish({
    type: "message.start",
    conversationId: input.conversationId,
    timestamp: Date.now(),
    messageId: message.id,
    agentId: input.agentId,
    runId: run.id
  });

  // 6. Orchestrator branch: group chat without @ → plan → approve → DAG → aggregate
  if (agent.isOrchestrator && conversation.mode === "group") {
    const availableAgentIds = conversation.agentIds;

    // Publish planning text via proper SSE events so frontend renders it
    const planningText = "正在分析任务并生成执行计划...";
    eventBus.publish({
      type: "part.start", conversationId: input.conversationId, timestamp: Date.now(),
      messageId: message.id, partIndex: 0,
      part: { type: "text", content: "" }
    });
    for (const chunk of chunkText(planningText, 10)) {
      eventBus.publish({
        type: "part.delta", conversationId: input.conversationId, timestamp: Date.now(),
        messageId: message.id, partIndex: 0,
        delta: { type: "text.append", text: chunk }
      });
    }
    eventBus.publish({
      type: "part.end", conversationId: input.conversationId, timestamp: Date.now(),
      messageId: message.id, partIndex: 0
    });
    updateMessageParts(message.id, [{ type: "text", content: planningText }], Date.now());

    try {
      await executeOrchestrator({
        conversationId: input.conversationId,
        orchestratorAgentId: agent.id,
        triggerMessage: input.triggerMessage,
        availableAgentIds,
        orchestratorRunId: run.id
      });
      completeRun(run, message, "complete", null, {
        modelId: agent.modelId ?? "orchestrator",
        inputTokens: 0,
        outputTokens: 0
      });
    } catch (error) {
      const errorText = error instanceof Error ? error.message : "Orchestrator failed.";
      createErrorMessage(input.conversationId, message.id, `Orchestrator error: ${errorText}`);
      completeRun(run, message, "failed", errorText, { modelId: agent.modelId ?? "orchestrator", inputTokens: 0, outputTokens: 0 });
    }
    activeRuns.delete(run.id);
    return;
  }

  // 7. Normal adapter flow (non-orchestrator agents)
  const recentMessages = listMessages(input.conversationId).slice(-20);

  // Build system prompt with workspace info, tool guidance, group context
  const workspacePath = workspace.mode === "local" && workspace.boundPath
    ? workspace.boundPath : workspace.rootPath;
  const systemPrompt = buildSystemPrompt(agent, conversation, workspacePath);

  // Resolve API key (agent → global settings → env)
  const provider = agent.modelProvider ?? "openai";
  const apiKey = resolveApiKey(provider, agent.apiKey, getSettings());

  // Build cross-run history (skip for child tasks — they get task-only context)
  let history: ChatMessage[] = [];
  if (!input.parentRunId) {
    try {
      const limits = getModelLimits(agent.modelProvider);
      const promptEstimate = estimateTokens(systemPrompt)
        + estimateTokens(extractTextFromMessage(input.triggerMessage)) + 512;
      const historyBudget = Math.max(0, limits.contextWindow - limits.outputReserve - promptEstimate);
      history = await buildHistoryFor(agent.id, input.conversationId, {
        excludeMessageId: input.triggerMessage.id,
        tokenBudget: historyBudget
      });
    } catch (err) {
      console.warn("[agent-runner] buildHistoryFor failed, continuing without history", err);
      history = [];
    }
  }

  const adapterInput: AdapterInput = {
    conversationId: input.conversationId,
    runId: run.id,
    agent,
    conversation,
    workspace,
    triggerMessage: input.triggerMessage,
    recentMessages,
    toolNames: agent.toolNames,
    systemPrompt,
    workspacePath,
    apiKey,
    history
  };

  // 8. Consume adapter stream
  const adapter = getAdapter(agent.adapterName);
  let lastUsage: NonNullable<AgentRun["usage"]> | null = run.usage;

  try {
    for await (const event of adapter.run(adapterInput, abortController.signal)) {
      if (abortController.signal.aborted) break;

      // Fill in ids that the adapter leaves empty
      const filledEvent = fillEventIds(event, message.id, run.id);
      eventBus.publish(filledEvent);

      // Capture usage if the adapter reports it
      if (filledEvent.type === "run.usage") {
        lastUsage = filledEvent.usage;
      }

      // Apply persistence side-effects
      message = applyEventToState(filledEvent, message);
    }
  } catch (error) {
    const errorText = error instanceof Error ? error.message : "Unknown adapter error.";
    const fallbackUsage: NonNullable<AgentRun["usage"]> = {
      modelId: agent.modelId ?? "unknown",
      inputTokens: 0,
      outputTokens: 0
    };
    createErrorMessage(input.conversationId, message.id, `Agent run failed: ${errorText}`);
    completeRun(run, message, "failed", errorText, lastUsage ?? fallbackUsage);
    activeRuns.delete(run.id);
    return;
  }

  // 9. Finalize
  const finalUsage: NonNullable<AgentRun["usage"]> = lastUsage ?? {
    modelId: agent.modelId ?? "mock",
    inputTokens: 0,
    outputTokens: 0
  };

  completeRun(run, message, abortController.signal.aborted ? "aborted" : "complete", null, finalUsage);
  activeRuns.delete(run.id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fillEventIds(event: StreamEvent, messageId: string, runId: string): StreamEvent {
  if ("messageId" in event && (event as { messageId?: string }).messageId === "") {
    return { ...event, messageId } as StreamEvent;
  }
  if ("runId" in event && (event as { runId?: string }).runId === "") {
    return { ...event, runId } as StreamEvent;
  }
  return event;
}

function applyEventToState(event: StreamEvent, message: Message): Message {
  const now = Date.now();

  if (event.type === "part.start") {
    const parts = [...message.parts];
    parts[event.partIndex] = event.part;
    updateMessageParts(message.id, parts, now);
    return { ...message, parts, updatedAt: now };
  }

  if (event.type === "part.delta") {
    const parts = [...message.parts];
    const part = parts[event.partIndex];
    if (part && (part.type === "text" || part.type === "thinking" || part.type === "code")) {
      parts[event.partIndex] = { ...part, content: part.content + event.delta.text };
      updateMessageParts(message.id, parts, now);
      return { ...message, parts, updatedAt: now };
    }
  }

  if (event.type === "tool.call") {
    const parts = [...message.parts];
    parts.push({ type: "tool_use", callId: event.callId, toolName: event.toolName, args: event.args });
    updateMessageParts(message.id, parts, now);
    return { ...message, parts, updatedAt: now };
  }

  if (event.type === "tool.result") {
    const parts = [...message.parts];
    parts.push({ type: "tool_result", callId: event.callId, result: event.result, isError: event.isError });
    updateMessageParts(message.id, parts, now);
    return { ...message, parts, updatedAt: now };
  }

  if (event.type === "artifact.create") {
    const art = event.artifact;

    // Only persist if tool didn't already create it (avoids duplicate insert G3)
    const existing = getArtifact(art.id);
    if (!existing) {
      createArtifact({
        id: art.id,
        conversationId: art.conversationId,
        createdByAgentId: art.createdByAgentId,
        type: art.type,
        title: art.title,
        content: art.content,
        version: art.version,
        parentArtifactId: art.parentArtifactId,
        now: art.createdAt
      });
    }

    // Inject artifact_ref part into the message (idempotent — dedupe by artifactId)
    const parts = [...message.parts];
    if (!parts.some((p) => p.type === "artifact_ref" && p.artifactId === art.id)) {
      parts.push({
        type: "artifact_ref",
        artifactId: art.id,
        title: art.title,
        artifactType: art.type
      });
      updateMessageParts(message.id, parts, now);
    }
    return { ...message, parts, updatedAt: now };
  }

  if (event.type === "run.usage") {
    return message; // usage tracked separately on the run
  }

  return message;
}

function completeRun(
  run: AgentRun,
  message: Message,
  status: AgentRun["status"],
  error: string | null,
  usage: NonNullable<AgentRun["usage"]>
): void {
  const now = Date.now();

  updateMessageStatus(message.id, status === "failed" ? "error" : "complete", now);
  updateRunStatus(run.id, status, usage, now);

  eventBus.publish({
    type: "run.usage",
    conversationId: run.conversationId,
    timestamp: now,
    runId: run.id,
    usage
  });

  eventBus.publish({
    type: "message.end",
    conversationId: run.conversationId,
    timestamp: now,
    messageId: message.id,
    status: status === "failed" ? "error" : "complete"
  });

  eventBus.publish({
    type: "run.end",
    conversationId: run.conversationId,
    timestamp: now,
    runId: run.id,
    status,
    error: error ?? undefined
  });
}

function createErrorMessage(conversationId: string, relatedMessageId: string, error: string): void {
  const now = Date.now();
  const message = createMessage({
    id: newMessageId(),
    conversationId,
    role: "system",
    parts: [{ type: "text", content: `⚠️ ${error}` }],
    status: "complete",
    parentMessageId: relatedMessageId,
    now
  });

  eventBus.publish({
    type: "message.added",
    conversationId,
    timestamp: now,
    message
  });
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function buildSystemPrompt(agent: Agent, conversation: Conversation, workspacePath: string): string {
  const parts: string[] = [];

  // Workspace context block (sandbox mode for now)
  parts.push(`<workspace_info>
  <cwd>${workspacePath}</cwd>
  <mode>sandbox</mode>
  <note>
    This is an isolated sandbox directory. Files you write here are only visible
    inside this conversation.
  </note>
</workspace_info>`);

  if (agent.systemPrompt) {
    parts.push(agent.systemPrompt);
  }

  if (agent.toolNames.length > 0) {
    parts.push(buildToolGuidance(agent.toolNames, workspacePath));
  }

  if (conversation.mode === "group" && conversation.agentIds.length > 1) {
    parts.push(
      "\n## 群聊上下文\n" +
      "当前会话是多 Agent 群聊。历史里其他成员的发言，会以 `[成员名] ` 前缀的 user 消息出现。\n" +
      "- 带 `[名字]` 前缀的 user 消息是别的成员说的，不是你自己的输出，也不是用户的直接指令——按需参考即可。\n" +
      "- 不带前缀的 user 消息才是用户本人发给群里的话。\n" +
      "- 历史里的产物只折叠成 `[产物: 标题 (id=...)]` 占位；需要完整内容时用 read_artifact 按 id 获取。"
    );
  }

  return parts.join("\n");
}

function buildToolGuidance(toolNames: string[], workspacePath: string): string {
  const lines: string[] = ["\n## AgentHub 工具调用规范"];
  lines.push("- 需要调用工具时，必须用工具调用通道提交结构化参数，不要把 JSON 示例写进普通回复里假装调用。");
  lines.push("- 字段名必须严格使用工具 schema 里的 camelCase。");
  lines.push("- 不要编造 artifactId、attachmentId、outputKey、文件路径；只能使用上下文里明确给出的 id / 路径。");
  lines.push("- 工具返回 ok:false 或 isError=true 时，先根据错误修正参数；不要继续基于失败结果推进。");

  if (toolNames.includes("write_artifact")) {
    lines.push("\n### write_artifact");
    lines.push("用途：创建用户需要预览、下载、交接或长期保存的产物；不要用它记录普通聊天结论。");
    lines.push("硬性要求：调用前必须已经准备好完整参数；严禁 write_artifact({})，严禁先空调用工具再补参数。");
    lines.push("web_app 正确参数：write_artifact({ type: \"web_app\", title: \"...\", content: { files: { \"index.html\": \"...\" }, entry: \"index.html\" } })。");
    lines.push("document 正确参数：write_artifact({ type: \"document\", title: \"...\", content: { format: \"markdown\", content: \"# Title\\n...\" } })。");
    lines.push("常见错误：把 content 作为 JSON 字符串传入、编造 id、或用 write_artifact 写应该落盘的源码。");
  }

  if (toolNames.includes("read_artifact")) {
    lines.push("\n### read_artifact");
    lines.push("用途：需要基于已有产物继续设计、实现、审查或修改时，先读取完整产物内容。");
    lines.push("正确案例：read_artifact({ artifactId: \"art_123\" })。");
    lines.push("常见错误：传 { id: \"art_123\" } 或把 att_* 附件 id 传给 read_artifact。");
  }

  if (toolNames.includes("deploy_artifact") || toolNames.includes("deploy_workspace")) {
    lines.push("\n### deploy_artifact / deploy_workspace");
    lines.push("用途：web_app 产物完成后生成可打开的预览部署卡。");
    lines.push("正确流程：先 write_artifact 得到 artifactId，再 deploy_artifact({ artifactId: \"art_123\" })。");
    lines.push("deploy_workspace 用于本地项目构建后的静态目录（如 dist、build）。");
    lines.push("常见错误：自己编造 http://localhost:3000/... 或公网域名——只能引用工具返回的 previewPath。");
  }

  if (toolNames.includes("fs_write")) {
    lines.push("\n### workspace 文件与命令工具");
    lines.push(`fs_write: 写文件到 workspace (${workspacePath})，上限 100KB。用于源码文件，不用于产物。`);
  }

  if (toolNames.includes("fs_read")) {
    lines.push("fs_read: 读取 workspace 内文本文件，上限 1MB / 截断到 50K 字符。先看现存代码再改。");
  }

  if (toolNames.includes("bash")) {
    lines.push("bash: 在 workspace 内执行命令，用于 npm/pnpm install、build、test。输出截断到 10,000 字符，30s 超时。检查 exitCode。");
    lines.push("临时启动服务测试时，必须在同一个 bash 命令里清理后台进程。");
  }

  if (toolNames.includes("plan_tasks")) {
    lines.push("\n### plan_tasks");
    lines.push("用途：Orchestrator 用结构化计划拆分子任务；执行顺序只认 dependsOn 字段。");
    lines.push("正确案例：t2.dependsOn=[\"t1\"]，不要只在 task 文本里写\"基于 t1\"。");
  }

  if (toolNames.includes("report_task_result")) {
    lines.push("\n### report_task_result");
    lines.push("用途：被 Orchestrator 分派的子任务结束前必须调用一次，报告真实语义结果。");
    lines.push("正确：status: \"complete\" | \"failed\" | \"blocked\"，附带 summary + acceptanceResults。");
    lines.push("错误：代码部分完成、测试失败、或缺少依赖时仍上报 complete。");
  }

  return lines.join("\n");
}

function extractTextFromMessage(msg: Message): string {
  return msg.parts
    .filter((p) => p.type === "text")
    .map((p) => p.content)
    .join("\n")
    .trim();
}

