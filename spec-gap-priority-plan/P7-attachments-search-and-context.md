# P7 - 附件、搜索与长期上下文

## 对应 specs

- `specs/01-core-entities.md`
- `specs/03-message-parts.md`
- `specs/05-adapter-interface.md`
- `specs/07-tools.md`
- `specs/09-frontend-architecture.md`
- `specs/13-conversation-context.md`
- `specs/16-message-search.md`

## 当前问题

当前已经有：

- attachments 表。
- image_attachment/file_attachment 类型。
- MessageInput 附件 icon 占位。
- conversation_context_summaries 表。

缺口：

- 没有 attachment upload API/service。
- 没有 `read_attachment` 工具。
- sendMessage 不支持 attachment ids。
- AdapterInput 不支持 attachments。
- CustomAdapter 不支持 multimodal image_url。
- 没有 global search DB FTS、service、API、store、UI。
- 没有 `conversation-context.ts`。
- 没有 `/compact` 或 compact API。
- UsageBadge/token budget 不存在。

## 需要做的内容

1. Attachment service。
   - 上传文件到 `workspace.rootPath/attachments/<id>-<fileName>`。
   - 校验路径、安全文件名、大小、mime。
   - 写 attachments 表。
   - 删除 conversation 时随 workspace 删除物理文件。

2. Attachment API/UI。
   - `POST /api/conversations/:id/attachments`。
   - `GET /api/conversations/:id/attachments`。
   - `GET /api/attachments/:id/download` 或安全读取端点。
   - MessageInput 支持选择、预览、移除。
   - sendMessage 支持 attachmentIds。
   - MessageParts 渲染 AttachmentChip。

3. `read_attachment` 工具。
   - 只允许读取当前 conversation 的 attachment。
   - 文本附件限制大小并截断。
   - 图片可返回 metadata 或 base64，按 adapter 能力决定。

4. 多模态 CustomAdapter。
   - supportsVision=true 时图片附件转 OpenAI `image_url` content block。
   - supportsVision=false 时只放文本占位。

5. 全文搜索。
   - 新增 FTS5 `messages_fts` 虚拟表。
   - insert/update/delete triggers，streaming 消息不索引。
   - migration/backfill。
   - `src/server/search-service.ts`。
   - `GET /api/search`。
   - `src/stores/search-store.ts`。
   - `GlobalSearch`、trigger、result item、jump highlight。
   - 中文短词 LIKE fallback。

6. 长期上下文。
   - `buildHistoryFor` 见 P1。
   - token budget 与 model registry。
   - `POST /api/conversations/:id/compact`。
   - `/compact` slash command。
   - summary 写 `conversation_context_summaries`。
   - compact 成功写 system message。

7. UsageBadge。
   - 聚合 run.usage。
   - 显示 input/output/cache。
   - 显示 lastInputTokens/contextWindow。
   - 超阈值颜色提示。

## Spec 13 上下文工程二阶段详细计划

P1 先完成基础 history。P7 负责把上下文工程补到可长期使用：

- token budget。
- manual compact。
- summary 注入。
- usage 可视化。
- attachment 占位与多模态边界。

### Context Summary

新增：

- `src/server/context-summary-service.ts`
- `src/app/api/conversations/[id]/compact/route.ts`
- `src/server/context-summary-service.test.ts`

Compact 入口：

- 用户发送 `/compact`。
- UsageBadge popover 点击“压缩上下文”。

Compact 不创建普通 user message，不触发 AgentRun。

流程：

1. 选取可压缩历史消息。
2. 排除 pinned messages。
3. 排除已被最新 summary 覆盖的消息。
4. 生成 summary。
5. 写 `conversation_context_summaries`。
6. 写一条 role=system 的可见反馈消息。

第一版 summary 生成策略：

- 如果配置了可用 LLM，用 custom provider 生成。
- 如果没有 key，使用 deterministic heuristic summary，至少提取最近目标、文件、artifact ids。
- 不因 compact 失败破坏会话。

Summary 内容必须包含：

- 用户目标。
- 已确认需求。
- 已完成事项。
- 未解决问题。
- 重要文件/命令。
- artifact id/title。
- 后续注意事项。

Summary 不应包含：

- 大段 tool_result。
- 完整代码。
- thinking。
- 寒暄和重复内容。

### Summary 注入

`buildHistoryFor` 在 P7 增强：

```text
latest summary
pinned messages
recent messages not covered by summary
current trigger message
```

规则：

- summary 作为最早的一条 user role context message。
- 被 summary 覆盖的非 pinned 普通消息不再重复注入。
- pinned messages 即使被 summary 覆盖也保留原文占位。

### UsageBadge

新增：

- `src/components/usage-badge.tsx`
- `src/shared/model-registry.ts`

显示：

- 本会话累计 input/output/cache tokens。
- 最近一次 run input tokens。
- context used / context window。
- per-agent 或 per-model 分解。

颜色：

- < 50% neutral。
- 50-80% warning。
- > 80% danger。

数据来源：

- `agent_runs.usage`。
- `run.usage` StreamEvent。
- model registry。

### 与附件的关系

Context history 中附件默认只作为占位：

- `[图片附件: fileName]`
- `[文件附件: fileName]`

真正读取：

- 文本附件：agent 调 `read_attachment`。
- 图片附件：supportsVision 时当前触发消息可多模态投递；旧历史图片不重复 base64 投递。

### 测试清单

- `/compact` 后 summary 表新增一行。
- compact feedback system message 可见。
- summary 覆盖范围之前的普通消息不进入 history。
- pinned 仍进入 history。
- 没有 key 时 heuristic compact 不崩。
- UsageBadge 在有 run.usage 后显示。
- 高 context 使用率颜色变化。

## 验收标准

- 用户可上传图片/文件并发送。
- message.parts 包含 attachment part。
- Agent 可通过 `read_attachment` 读取文本附件。
- supportsVision custom agent 可收到图片附件。
- `Cmd/Ctrl+K` 可打开全局搜索。
- 中文短词能通过 LIKE 兜底搜到。
- 点击搜索结果跳转并高亮消息。
- `/compact` 写入 summary，后续 history 不重复注入被覆盖消息。
- pinned message 不被 token budget 截断。

## 不在本优先级范围

- 不做语义搜索。
- 不做 OCR。
- 不做移动端附件上传。
