# P1 - AdapterInput、上下文历史与 Artifact 单一来源

## 对应 specs

- `specs/03-message-parts.md`
- `specs/04-artifacts.md`
- `specs/05-adapter-interface.md`
- `specs/13-conversation-context.md`

## 当前问题

当前 AdapterInput 与 spec 差异较大：

- spec 要求 `runId`、`parentRunId`、`prompt`、`workspacePath`、`systemPrompt`、`apiKey`、`attachments`、`history`、`customConfig` 等字段。
- 当前代码传的是 `agent`、`conversation`、`workspace`、`triggerMessage`、`recentMessages`、`toolNames`。
- 当前 CustomAdapter 自己从 `recentMessages` 拼历史，只取最近 20 条 text part，未实现 Spec 13 的 agent 视角隔离、artifact 占位、pinned 永远注入、token budget。
- 当前没有 `src/server/conversation-context.ts`。
- 当前 AgentRunner 没有给 systemPrompt 注入工具使用规范、workspace_info、group chat note、pinned messages。

## 需要做的内容

1. 设计一个向后兼容的 AdapterInput。
   - 不必一次完全改成 spec 形状，但必须补 `runId`、`parentRunId`、`systemPrompt`、`workspacePath`、`apiKey`、`history`。
   - 保留 `agent/conversation/workspace/triggerMessage` 也可以，但要明确这些是内部便利字段。

2. 新增 conversation context service。
   - 文件建议：`src/server/conversation-context.ts`。
   - 实现 `buildHistoryFor(agentId, conversationId, options)`。
   - 只保留 complete 消息。
   - 丢弃 thinking/tool_use/tool_result。
   - artifact_ref 折叠为 `[产物: title (id=art_xxx)]`。
   - 其他 agent 的公开发言在群聊中以 `[Agent名] ...` 注入为 user role。
   - pinned messages 永远注入并去重。

3. AgentRunner 构造统一 prompt。
   - 注入 workspace 信息。
   - 注入当前 agent 可用工具说明。
   - local workspace 且无文件工具时提示能力边界。
   - 群聊 custom adapter 增加 group context note。

4. CustomAdapter 消费 `input.history`。
   - `[system, ...history, currentUser]`。
   - 支持附件后续接入，P1 可先保留 TODO。
   - DeepSeek reasoning 内容要么正确回传给下一轮 within-run messages，要么明确不支持 thinking mode。

5. Artifact 注入路径单一化。
   - `write_artifact` 返回 artifactId 后，Adapter 拉 DB 完整 artifact。
   - AgentRunner 插入 artifact_ref。
   - 前端按 artifact_ref 打开右侧预览。

## Spec 13 上下文工程详细计划

### 目标

上下文工程的目标不是简单把最近 20 条消息塞给模型，而是让每个 Agent 看到“对它有意义、不会污染工具链、不会无限膨胀”的历史视图。

第一阶段必须做到：

- 跨 run 有记忆。
- 群聊中每个 Agent 有主体视角。
- pinned messages 永远保留。
- Artifact 只用引用占位，不内联全文。
- thinking/tool_use/tool_result 不进入跨 run 历史。
- 历史构造失败时退化为空 history，不让 run 失败。

### 新增模块

建议新增：

- `src/server/conversation-context.ts`
- `src/server/conversation-context.test.ts`
- `src/shared/model-registry.ts`
- `src/shared/token-estimate.ts`

`conversation-context.ts` 负责 DB 读取与序列化，不调用 LLM、不访问 workspace、不读取 artifact 全文。

### 核心函数

```ts
interface BuildHistoryOptions {
  maxTurns?: number;
  includePinned?: boolean;
  excludeMessageId?: string;
  tokenBudget?: number;
}

export async function buildHistoryFor(
  agentId: string,
  conversationId: string,
  options?: BuildHistoryOptions
): Promise<ChatCompletionMessageParam[]>;
```

### Message 选取规则

1. 读取 conversation。
2. 读取同会话 complete 消息。
3. 排除 `excludeMessageId`，避免当前触发消息重复进入 history。
4. 取最近 `maxTurns` 条普通消息。
5. 合并 `pinnedMessageIds` 指向的消息。
6. 按 message id 去重。
7. 按 createdAt 升序排列。
8. 如果有 tokenBudget，从老到新丢弃非 pinned 消息，pinned 不丢。

注意：当前代码的 message status 是 `"complete"`，spec 13 文中有 `"completed"` 的旧表述，落地时以代码类型为准。

### Part 序列化规则

`role='user'`：

- `text` -> 原文。
- `image_attachment` -> `[图片附件: fileName]`。
- `file_attachment` -> `[文件附件: fileName]`。
- 其它 part 忽略。

当前 Agent 自己的 `role='agent'`：

- `text` -> assistant content。
- `code` -> fenced code text 或 plain text block。
- `artifact_ref` -> `[产物: title (id=art_xxx)]`。
- `deploy_status` -> `[部署预览: title (/deployments/dep_xxx)]` 或 `[部署失败: ...]`。
- 丢弃 `thinking/tool_use/tool_result`。

其它 Agent 的 `role='agent'`：

- 群聊中转成 user role。
- 前缀为 `[Agent名] `。
- 只保留公开 text/code/artifact_ref/deploy_status。
- 丢弃 thinking/tool_use/tool_result。
- 单聊中理论上不会出现其它 Agent，出现也跳过。

`role='system'`：

- 仅保留系统可见反馈中需要入上下文的内容。
- compact 反馈消息默认不进入 history，真正摘要来自 `conversation_context_summaries`。

### Artifact 占位查询

实现时不要 N+1 查询每个 artifact。

推荐流程：

1. 扫描候选 messages，收集 artifact_ref ids。
2. 一次性查询 artifact id -> title/type/version。
3. 序列化时补 title。
4. 找不到 artifact 时输出 `[产物已删除: art_xxx]`。

### Token budget

第一阶段可以只做粗估：

```ts
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

预算来源：

- 已知模型：`model-registry.ts` 精确配置 contextWindow/outputReserve。
- 未知 provider fallback：
  - anthropic: 200K
  - openai: 128K
  - deepseek: 64K
  - volcano-ark: 32K
  - openai-compatible: 128K

AgentRunner 计算：

```text
historyBudget = contextWindow - outputReserve - estimate(systemPrompt) - estimate(currentUser) - safetyMargin
```

当预算不足：

- pinned 不丢。
- 非 pinned 从最旧开始丢。
- 如果 pinned 自己就超预算，仍保留，但写 warning log。

### AgentRunner 集成点

`src/server/agent-runner.ts` 中构造 AdapterInput 时：

1. 创建 run record，得到 runId。
2. 计算 effective workspacePath。
3. resolve apiKey。
4. 构造 systemPrompt：
   - agent.systemPrompt
   - workspace_info
   - available tools instructions
   - group chat note
   - local workspace capability note
5. 调 `buildHistoryFor(...)`。
6. 将 `history/runId/workspacePath/systemPrompt/apiKey` 放进 AdapterInput。

如果 `buildHistoryFor` 抛错：

- `console.warn`。
- history = []。
- 不影响 run。

### 测试清单

- 单聊两轮：第二轮 history 包含第一轮 user 和当前 Agent 自己的 assistant 公开文本。
- 工具调用历史：上一轮的 tool_use/tool_result 不进入 history。
- artifact_ref：history 只含 artifact 占位，不含 artifact content。
- 群聊：另一个 Agent 的公开文本以 `[名字]` 前缀进入 user role。
- pinned：老消息超出 maxTurns 仍保留。
- excludeMessageId：当前触发消息不重复。
- tokenBudget：超预算时丢弃旧非 pinned。
- artifact missing：输出 tombstone 占位。

## Artifact 单一来源详细计划

当前必须先定一个原则：DB 写入只发生在一个地方。

推荐采用：

```text
write_artifact tool -> createArtifact(DB) -> return artifactId
CustomAdapter -> getArtifact(DB) -> emit artifact.create
AgentRunner -> if artifact exists, do not insert; inject artifact_ref only
```

这样好处是：

- 工具 handler 是副作用入口，符合 Spec 07。
- Adapter 只翻译 tool result 成 StreamEvent。
- AgentRunner 是 event -> message parts 的持久化入口，但不重复创建 artifact。

需要修改：

- `src/server/tools/write-artifact.ts` 返回 `{ artifactId, title, type, version }`。
- `src/server/adapters/custom-agent-adapter.ts` 在检测 artifactId 后调用 repository/service 拉完整 artifact。
- `src/server/agent-runner.ts` 的 artifact.create 分支改成 upsert-safe 或 “已存在则跳过 insert”。
- 增加测试防止 duplicate insert。

## 验收标准

- 连续两轮单聊中，第二轮 Agent 能看到第一轮公开文本。
- 群聊中，worker 能看到其他 agent 的公开文本，但看不到 thinking/tool_result。
- pin 的消息在 20 条历史之外仍被注入。
- artifact_ref 在 history 中只作为占位，不内联全文。
- CustomAdapter 的 ToolContext.runId 是真实 run id。
- `write_artifact` 不重复写 DB。

## 不在本优先级范围

- 不做自动 compact。
- 不做精确 tokenizer。
- 不做 ClaudeCode/Codex session resume。
- 不做多模态附件投递。
