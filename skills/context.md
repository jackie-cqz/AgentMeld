# AgentMeld 上下文管理

> 对话历史 → Token 预算 → Summary → Pinned → Recent → LLM 输入。

## 一次 Agent 调用的上下文构成

```
1. System Prompt     — Agent 角色 + Workspace + 工具规范
2. Summary           — 早期对话的 AI 压缩摘要（如有）
3. Pinned Messages   — 用户手动置顶的关键消息（原文注入）
4. Recent Messages   — 摘要覆盖点之后的近期消息
5. Current Turn      — 当前用户消息
6. Output Reserve    — 为 LLM 回复预留的 token
```

预算公式：

```
systemTokens + summaryTokens + pinnedTokens + recentTokens + currentTurnTokens + outputReserve ≤ modelWindow
```

`buildHistoryFor()` 在 `src/server/conversation-context.ts` 中实现。

## 消息序列化

跨 Run 历史构建时，消息被序列化为 `ChatMessage[]` 格式：

```typescript
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}
```

序列化规则：
- Agent 自身 → `role: "assistant"`, 只保留公开文本
- 群聊中其他 Agent → `role: "user"`, 带 `[AgentName]` 前缀
- 产物引用 → 折叠为 `[产物: 标题 (id=art_xxx)]` 占位
- thinking / tool_use / tool_result → 不进入历史
- 子 Agent 任务 → 不注入跨 Run 历史

## 上下文压缩

### 触发

前端 `ContextStatsPanel` → `POST /api/conversations/:id/compact`

### 选取

`selectCompactionWindow()` 选取摘要覆盖点之后、最近 8 条之前的消息，排除 system 和 pinned。

### 分块滚动摘要

消息 >10K token 时自动分块：

```
existingSummary + chunk1 → summary1
summary1 + chunk2 → summary2
summary2 + chunk3 → finalSummary  ← 只有全部成功后写入 DB
```

中间 chunk 失败不落库，最终 chunk 成功前不更新覆盖边界。

### 并发锁

`context_compaction_jobs` 表带 `UNIQUE WHERE status IN ('queued','running')`，同一会话只能有一个活跃任务。

### 启动恢复

`recoverCompactionJobs()` 将遗留 `queued/running` 标记 `interrupted`。

## Pinned Messages

- 通过消息 hover 操作 Pin/Unpin
- 写入 `conversations.pinned_message_ids`
- **永远不被裁剪**：token 超出时优先删 recent，其次 summary，pinned 最后
- 当 system + pinned + currentTurn 超过窗口时：返回错误，不调 LLM

## 会话置顶

独立于消息 Pin——`conversations.pinned_at` 字段，用于侧栏排序。

## Token 估算

```typescript
estimateTokens(text) = Math.ceil(text.length / 4)
```

启发式算法（4 字符 ≈ 1 token），加上 128 token 协议余量。模型窗口和输出预留从 `src/shared/model-registry.ts` 读取。

## 前端

| 组件 | 功能 |
|------|------|
| `ContextStatsPanel` | 上下文统计 + 手动压缩按钮 |
| `PinnedMessagesBar` | 当前会话置顶消息列表 |

## 相关文件

| 文件 | 内容 |
|------|------|
| `src/server/conversation-context.ts` | buildHistoryFor / runCompaction / 序列化 |
| `src/server/context-compaction-service.ts` | selectCompactionWindow / chunkCompactionMessages |
| `src/server/agent-runner.ts` | 预算计算 + buildHistoryFor 调用 |
| `src/shared/token-estimate.ts` | estimateTokens |
| `src/shared/model-registry.ts` | 模型窗口配置 |
| `src/components/context-stats-panel.tsx` | 上下文统计面板 |
| `specs/13-conversation-context.md` | 规格 |
