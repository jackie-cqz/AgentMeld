# 上下文压缩完整目标与优先级计划

## 1. 文档目标

本文档定义 Agent-Conference 对话上下文压缩的完整目标、实现边界、优先级、代码修改点和验收标准。

目标不是简单增加一个“生成摘要”按钮，而是建立一条可靠闭环：

```text
完整消息持久化
  -> 选择尚未压缩的历史区间
  -> 使用 DeepSeek 生成可继续工作的结构化摘要
  -> 原子保存摘要覆盖边界
  -> 后续 Agent 运行注入摘要、置顶消息和近期消息
  -> 按模型上下文窗口执行预算裁剪
  -> 前端展示真实的下轮上下文构成
  -> 达到阈值后可安全自动压缩
```

本计划只面向当前 Web + DeepSeek Custom Agent 路径，不包含：

- Claude Code / Codex SDK session 清理和恢复。
- Electron 桌面部署。
- 移动端上下文管理。
- 跨 conversation 长期记忆。
- 引入精确 tokenizer 新依赖。

## 2. 规格依据

实现和验收必须对照以下文件：

- `specs/13-conversation-context.md`
- `openspec/specs/conversation-context/spec.md`
- `specs/03-message-parts.md`
- `specs/06-orchestrator-flow.md`
- `specs/08-db-schema.md`
- `specs/09-frontend-architecture.md`
- `src/server/conversation-context.ts`
- `src/server/agent-runner.ts`
- `src/server/adapters/custom-agent-adapter.ts`
- `src/app/api/conversations/[id]/compact/route.ts`
- `src/components/context-stats-panel.tsx`
- `src/stores/reducers/compaction-events.ts`

## 3. 当前实现基线

目前已经具备：

- `conversation_context_summaries` 持久化表。
- `buildHistoryFor()` 对 recent、pinned、summary 的组合。
- AgentRunner 根据模型窗口计算 history token budget。
- CustomAgentAdapter 把 `input.history` 注入请求。
- `POST /api/conversations/:id/compact` 手动压缩入口。
- DeepSeek Chat Completions 摘要调用。
- `compaction.start/progress/end/error` SSE 事件。
- 上下文统计面板和预算预览接口。

当前主要缺陷：

1. 二次压缩仍可能重复读取旧摘要已经覆盖的消息。
2. 覆盖边界主要依赖 `createdAt`，同毫秒消息可能被漏掉。
3. summary token 没有完整纳入 history budget。
4. 压缩源消息逐条截断到 800 字符，可能丢失关键结论。
5. 超长历史没有分块滚动摘要能力。
6. 同一 conversation 可以并发启动多个压缩任务。
7. 较晚完成的旧任务可能覆盖更新的摘要边界。
8. 前端部分统计使用全部消息估算，并把窗口写死为 DeepSeek 64K。
9. 没有自动压缩阈值和失败降级策略。

## 4. 目标上下文模型

普通 Custom Agent 的一次请求按以下顺序构建：

```text
1. System Prompt
   - Agent 角色
   - Workspace
   - 工具规范
   - 群聊语义

2. Durable Context
   - 最新 conversation summary
   - 全部 pinned messages

3. Recent Context
   - 摘要覆盖边界之后的近期完整消息
   - 按 token budget 从旧到新裁剪

4. Current Turn
   - 当前用户消息

5. Output Reserve
   - 为 DeepSeek 回复、推理和工具调用预留 token
```

总预算必须满足：

```text
systemTokens
+ summaryTokens
+ pinnedTokens
+ recentTokens
+ currentTurnTokens
+ protocolMargin
+ outputReserve
<= modelContextWindow
```

Pinned 消息拥有最高保留优先级，但不能无限制破坏模型请求。若 pinned 内容本身已经超过可用窗口，系统必须返回明确诊断，不能继续发送一个必然失败的请求。

## 5. 摘要内容契约

每次生成的 summary 必须是“可继续执行工作的状态快照”，至少包含：

```markdown
## 用户目标
- 当前最终目标和明确要求

## 已确认约束
- 技术栈、范围、用户明确排除项

## 已完成工作
- 已实现内容、关键决定和验证结果

## 重要资源
- 文件路径
- Artifact ID、标题和类型
- 关键命令及结果

## 当前问题
- 已知错误、失败原因和风险

## 下一步
- 尚未完成且可以直接执行的任务
```

摘要不得包含：

- 寒暄和重复确认。
- 完整 thinking。
- 大段 tool result。
- 大段源代码。
- 已被后续结果推翻的旧决定。
- 未在原始消息里出现的文件、Artifact ID 或完成状态。

## 6. 优先级总览

| 优先级 | 主题 | 完成后的能力 |
|---|---|---|
| P0 | 修复压缩区间与覆盖边界 | 二次压缩不重复、不漏消息、不倒退 |
| P1 | 修复上下文预算闭环 | summary/pinned/recent 真正受模型窗口约束 |
| P2 | 分块滚动摘要 | 超长会话可以稳定压缩，不靠逐条截断 |
| P3 | 并发、幂等与故障恢复 | 重复点击、超时、服务重启不会破坏摘要 |
| P4 | 前端统计与人工控制 | 用户能看懂下轮上下文，并可靠操作压缩 |
| P5 | 自动压缩与质量治理 | 长会话自动稳定运行，并能监测摘要质量 |

---

## P0 - 压缩区间与覆盖边界正确性

### 目标

保证每次压缩只处理“最新摘要覆盖点之后、近期保留区之前”的新增消息。

### 代码任务

1. 从 API Route 中提取纯函数和服务边界。
   - 新增 `src/server/context-compaction-service.ts`。
   - Route 只负责参数解析、HTTP 响应和启动任务。
   - 消息选择、摘要调用、结果保存进入服务层。

2. 实现 `selectCompactionWindow()`。
   - 读取最新 summary。
   - 按 `coveredUntilMessageId` 在完整有序消息中定位覆盖点。
   - 只选择覆盖点之后的消息。
   - 排除 `system`、非 complete 和 pinned 消息。
   - 保留最近 8 条未压缩消息。
   - 新增消息少于 3 条时返回不可压缩原因。

3. 修复覆盖边界比较。
   - `coveredUntilMessageId` 是主边界。
   - `coveredUntilCreatedAt` 只用于兼容和诊断。
   - 如果数据库中找不到覆盖消息，禁止根据时间静默跳过整段历史。
   - 返回明确的 `summary_boundary_missing` 错误或采用受测试的安全回退。

4. 修复 `buildHistoryFor()` 的摘要后消息选择。
   - 使用与压缩服务相同的边界函数。
   - 避免压缩选择和运行时历史选择使用两套不同规则。

5. 保存摘要前验证边界单调前进。
   - 新摘要覆盖位置必须晚于现有摘要。
   - 不允许旧压缩结果成为最新有效摘要。

### 重点文件

- `src/server/context-compaction-service.ts`（新增）
- `src/server/conversation-context.ts`
- `src/app/api/conversations/[id]/compact/route.ts`
- `src/server/conversation-context.test.ts`
- `src/server/context-compaction-service.test.ts`（新增）

### 验收标准

- 首次压缩 20 条消息，保留最后 8 条，摘要覆盖前 12 条。
- 新增 10 条消息后二次压缩，旧的 12 条不会再次进入模型。
- pinned 消息不进入摘要源，并继续以原文注入上下文。
- 同一毫秒创建的多条消息不会因时间比较被误删。
- 已存在摘要但覆盖 message 不存在时，系统显式失败。
- 新摘要覆盖边界不能早于当前摘要。

---

## P1 - 模型上下文预算闭环

### 目标

保证发送给 DeepSeek 的所有输入组成部分都计入预算，避免压缩后仍然超过上下文窗口。

### 代码任务

1. 建立统一预算结构。

```typescript
interface ContextBudget {
  contextWindow: number;
  outputReserve: number;
  systemTokens: number;
  summaryTokens: number;
  pinnedTokens: number;
  recentTokens: number;
  currentTurnTokens: number;
  protocolMargin: number;
  remainingTokens: number;
}
```

2. 调整 AgentRunner。
   - 不再只计算 system + current turn 后把剩余全部交给 history。
   - `buildHistoryFor()` 返回 history 和预算明细，或先加载 durable context 再计算 recent budget。

3. 明确保留顺序。
   - system、current turn、output reserve 必须保留。
   - summary 优先于普通 recent。
   - pinned 优先于普通 recent。
   - recent 从最旧消息开始删除。

4. 处理 pinned 超预算。
   - pinned + system + current turn 已超过窗口时返回结构化错误。
   - 错误应说明 pinned 数量、估算 token 和可用预算。
   - 前端提示用户取消部分置顶或缩短当前输入。

5. 修复 token 估算一致性。
   - 全部路径统一使用 `estimateTokens()`。
   - 消息元数据和 XML/Markdown 包装增加固定 margin。
   - 预算预览与实际运行使用同一个计算函数。

### 重点文件

- `src/shared/model-registry.ts`
- `src/shared/token-estimate.ts`
- `src/server/conversation-context.ts`
- `src/server/agent-runner.ts`
- `src/components/context-stats-panel.tsx`

### 验收标准

- summary token 被计入总预算。
- recent 被裁剪后，总估算不超过 context window。
- pinned 消息不会被静默删除。
- pinned 自身超预算时不会调用 DeepSeek，并返回可理解错误。
- GET 预算预览与下一次实际构建的 token 明细基本一致。
- DeepSeek 的 context window 和 output reserve 来自 model registry，不在 UI 写死。

---

## P2 - 分块滚动摘要

### 目标

支持压缩数百条、数万 token 的历史，避免一次请求过大或逐条截断造成信息丢失。

### 代码任务

1. 删除固定的 `content.slice(0, 800)`。
   - 改为完整序列化公开内容。
   - 继续排除 thinking、tool_use 和完整 tool_result。
   - Artifact 只保留 title/type/id。
   - 文件和命令保留路径、命令、退出状态和简短结果。

2. 实现 `chunkCompactionMessages()`。
   - 目标每块约 8K-12K input token。
   - 不拆开单条短消息。
   - 单条超长消息按段落或 MessagePart 边界拆分。
   - 每个 chunk 带稳定的起止 message id。

3. 实现滚动摘要。

```text
existingSummary + chunk1 -> summary1
summary1 + chunk2 -> summary2
summary2 + chunk3 -> finalSummary
```

4. 每轮摘要继续遵守统一结构。
   - 后一轮负责合并并去重旧摘要。
   - 明确要求模型保留未完成事项和标识符。
   - 每轮输出限制在约 1,500-2,000 tokens。

5. 只在全部 chunk 成功后提交最终摘要。
   - 中间 summary 保持内存态。
   - 任意 chunk 失败，不更新数据库覆盖边界。

6. 支持 AbortSignal。
   - 每一次模型请求使用同一个外部中止信号。
   - 中止后发出 `compaction.error` 或专门的 aborted 状态。

### 重点文件

- `src/server/context-compaction-service.ts`
- `src/server/conversation-context.ts`
- `src/shared/token-estimate.ts`
- `src/shared/types.ts`

### 验收标准

- 200 条长消息能被拆成多个 chunk 完成压缩。
- 单条超过 chunk budget 的消息不会被静默截断。
- 第二块摘要能保留第一块的重要目标、文件和待办。
- 任意中间请求失败时，数据库不写入部分覆盖结果。
- 模型请求包含 AbortSignal，用户中止后停止后续 chunk。

---

## P3 - 并发、幂等与故障恢复

### 目标

保证同一会话只能存在一个有效压缩任务，并能正确处理重复请求、超时和进程重启。

### 代码任务

1. 增加 conversation 级压缩锁。
   - 第一阶段可使用进程内 `Map<conversationId, CompactionJob>`。
   - 重复 POST 返回当前任务状态，不重复调用模型。

2. 增加持久化任务状态。
   - 推荐新增 `context_compaction_jobs` 表。
   - 状态：`pending | running | complete | failed | aborted`。
   - 保存 source start/end、attempt、error、startedAt、finishedAt。
   - 此项涉及 DB schema，实施时同步更新 Spec 08 和 OpenSpec。

3. 实现幂等键。
   - 使用 `conversationId + baseSummaryId + coveredUntilMessageId`。
   - 同一个压缩窗口只产生一个有效任务。

4. 原子提交。
   - 在 SQLite transaction 内重新读取最新 summary。
   - 验证 base summary 未变化。
   - 验证新覆盖点向前推进。
   - 然后写入 summary 并完成 job。

5. 启动恢复。
   - 服务启动时把遗留 `running` job 标记为 failed。
   - 不自动假定模型请求已经完成。
   - 用户可以重新发起同一窗口压缩。

6. 超时和重试。
   - 单个 chunk 允许有限重试。
   - 仅网络超时、429、5xx 可重试。
   - 401、403、缺少 Key、无内容响应不自动重试。

### 重点文件

- `src/db/schema.ts`
- `src/db/bootstrap.ts`
- `specs/08-db-schema.md`
- `src/server/context-compaction-service.ts`
- `src/server/run-recovery.ts`
- `src/app/api/conversations/[id]/compact/route.ts`

### 验收标准

- 快速点击两次只产生一个模型任务。
- 两个并发结果不能让摘要覆盖边界倒退。
- 进程重启后遗留 running job 会变成 failed。
- 可重试错误按上限重试，不可重试错误立即显示。
- 同一压缩窗口重复请求返回已有任务状态。

---

## P4 - 前端观测与人工控制

### 目标

让用户能够看到“下一轮实际会发送什么”，而不是看到全部聊天记录的粗略 token 总和。

### 代码任务

1. 扩展预算预览响应。

```typescript
interface ContextBudgetPreview {
  modelProvider: string;
  modelId: string;
  contextWindow: number;
  outputReserve: number;
  systemTokens: number;
  summaryTokens: number;
  pinnedTokens: number;
  recentTokens: number;
  estimatedInputTokens: number;
  usagePercent: number;
  summaryCoveredMessageCount: number;
  recentMessageCount: number;
  omittedMessageCount: number;
  canCompact: boolean;
  compactableMessageCount: number;
  blockingReason: string | null;
}
```

2. 修改 `ContextStatsPanel`。
   - 删除基于全部前端 messages 的 `contextTokenEstimate`。
   - 删除写死的 DeepSeek 64K。
   - 使用后端预算预览渲染进度条。
   - 分项显示 summary、pinned、recent、output reserve。

3. 完善压缩状态。
   - 展示正在处理第几个 chunk。
   - 展示源消息数量和覆盖范围。
   - 展示失败原因和可重试操作。
   - 运行中禁用重复压缩按钮。

4. 增加摘要检查入口。
   - 用户可展开查看当前 summary。
   - 只读显示 coveredUntil 和生成时间。
   - 第一版不提供直接编辑，避免引入摘要版本语义。

5. 改进系统消息。
   - 成功：覆盖消息数量、摘要 token、保留近期消息数量。
   - 失败：明确是 Key、网络、模型输出还是边界冲突。
   - 系统消息不进入后续 LLM history。

### 重点文件

- `src/components/context-stats-panel.tsx`
- `src/stores/store-types.ts`
- `src/stores/reducers/compaction-events.ts`
- `src/shared/types.ts`
- `src/app/api/conversations/[id]/compact/route.ts`

### 验收标准

- UI 显示的窗口大小来自当前模型。
- UI 估算不再把全部聊天记录当成下一轮上下文。
- 压缩中能看到 chunk 进度。
- 缺少 DeepSeek Key 时前端显示配置错误。
- 用户能查看当前摘要和覆盖范围。
- SSE 断线重连后能通过 GET API 恢复任务状态。

---

## P5 - 自动压缩与质量治理

### 目标

在手动压缩稳定后，增加不会阻断用户工作的自动压缩策略和摘要质量检查。

### 代码任务

1. 自动触发策略。
   - 预算低于 70%：不动作。
   - 70%-85%：UI 提示建议压缩。
   - 超过 85%：发送新消息前尝试自动压缩。
   - compactable 消息不足时继续使用 recent 截断。

2. 自动压缩失败降级。
   - 不阻断当前用户消息。
   - 使用已有 summary + pinned + budget truncation。
   - 发布可见警告，提示手动处理。

3. 摘要输出校验。
   - 使用 zod 或确定性解析检查必需章节。
   - 检查已知 Artifact ID 和文件路径是否来自源上下文。
   - 检查 summary 非空且没有明显超过限制。
   - 校验失败可要求模型修复一次。

4. 摘要质量回归测试。
   - 用户目标不能丢失。
   - 用户明确排除项不能丢失。
   - 未完成任务不能被写成已完成。
   - Artifact ID、文件路径和失败原因必须保持准确。

5. 可观测性。
   - 记录压缩前 token、压缩后 token、节省比例。
   - 记录 chunk 数量、模型、耗时和失败类型。
   - 不记录 API Key 和完整私密消息内容。

### 重点文件

- `src/server/agent-runner.ts`
- `src/server/context-compaction-service.ts`
- `src/server/conversation-context.ts`
- `src/components/context-stats-panel.tsx`
- `src/shared/types.ts`

### 验收标准

- 高于阈值时能自动启动压缩。
- 自动压缩失败不会吞掉用户消息。
- 摘要缺少必需章节时不会直接保存。
- 摘要不能编造不存在的 Artifact ID。
- 可查看压缩前后 token 和节省比例。

## 7. 测试计划

### 单元测试

- 覆盖点定位和同毫秒消息排序。
- 摘要后消息选择。
- pinned 排除和重新注入。
- token budget 优先级。
- chunk 分割和单条超长消息处理。
- 摘要边界单调性。
- 可重试错误分类。

### API 测试

- GET 预算预览。
- POST 首次压缩。
- POST 二次增量压缩。
- 重复 POST 幂等。
- 缺少 Key。
- 模型 401、429、500、timeout 和空响应。

### 集成测试

- 压缩完成后，下一次 Custom Agent 请求包含 summary。
- 被 summary 覆盖的普通消息不再重复注入。
- pinned 老消息仍然存在。
- recent history 在窗口内从旧到新裁剪。
- Orchestrator child run 继续使用隔离 prompt，不注入普通全局 history。

### 前端测试

- compaction 事件状态转换。
- 正确显示预算分项。
- 运行中按钮禁用。
- 错误状态和重试。
- 会话切换后状态不串线。

## 8. 推荐实施顺序

1. 先完成 P0，解决重复压缩、漏消息和边界倒退。
2. 完成 P1，让摘要真正进入统一 token budget。
3. 完成 P2，支持长会话分块压缩。
4. 完成 P3，解决并发、幂等和恢复。
5. 完成 P4，前端改用后端真实预算。
6. 最后实施 P5 自动压缩。

P0-P2 是功能正确性的最低闭环。P3-P4 是可稳定交付的产品闭环。P5 必须建立在前四个阶段测试通过之后，不能先做自动触发再补底层正确性。

## 9. 完成定义

上下文压缩可以视为“做全”，需要同时满足：

- 多次压缩严格增量处理，不重复、不漏消息。
- 压缩失败不会破坏现有摘要。
- 长会话通过分块滚动摘要完成。
- summary、pinned、recent、current turn 全部进入统一预算。
- Agent 下一轮真实消费最新摘要。
- Orchestrator child context 隔离不被破坏。
- 用户能看到真实预算、压缩范围、状态和错误。
- 并发请求幂等，服务重启后状态可恢复。
- 自动压缩失败时有可靠降级。
- 单元、API、集成和前端测试覆盖关键边界。

