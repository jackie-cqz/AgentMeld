# Bug #001：Adapter 未将动态 Agent 列表发送给 DeepSeek

> 发现日期：2026-06-19  
> 严重程度：高  
> 影响范围：Orchestrator PLAN / Recovery / Aggregate 三个阶段

---

## 现象

Orchestrator 反复生成错误的 `agentId`（如 `frontend`、`web_dev`、`app-dev`），
即使提示词中已经动态注入了当前群聊的真实 Agent 列表和大量的禁止规则。

## 根因

Orchestrator 构造 `AdapterInput` 时，把动态生成的提示词写入了 `agent.systemPrompt` 字段，
但 `systemPrompt` 字段留空：

```typescript
// orchestrator-service.ts — PLAN 阶段（修复前）
const adapterInput: AdapterInput = {
  agent: { ...agent, toolNames: assessToolNames, systemPrompt: assessSystemPrompt },
  systemPrompt: "",   // ← 空字符串！
  ...
};
```

而 `custom-agent-adapter.ts` 实际发送给 DeepSeek 的是 `input.systemPrompt`：

```typescript
// custom-agent-adapter.ts — buildMessages()
messages.push({ role: "system", content: input.systemPrompt });
```

结果 DeepSeek 收到的 system prompt 永远是空字符串，**完全没有收到动态 Agent 列表**。
LLM 只能根据任务描述猜测 agentId，所以反复编造 `frontend`、`web_dev` 等不存在的 ID。

此问题在三处同时存在：

| 阶段 | 文件位置 | 状态 |
|------|---------|:--:|
| PLAN（Assess） | `runOrchestratorAssess()` | ✅ 已修复 |
| Recovery | `generateRecoveryPlan()` | ✅ 已修复 |
| Aggregate | `runAggregateStage()` | ✅ 已修复 |

## 修复

### 1. 正确写入 `input.systemPrompt`

将所有动态 prompt 写入 `systemPrompt` 字段而非 `agent.systemPrompt`：

```typescript
// orchestrator-service.ts — 修复后
const adapterInput: AdapterInput = {
  agent: { ...agent, toolNames: assessToolNames },
  systemPrompt: assessSystemPrompt,  // ← 正确位置！
  ...
};
```

### 2. `plan_tasks` 参数 schema 动态注入 `enum`

DeepSeek JSON 模式下，`enum` 比提示词文本可靠得多：

```json
{
  "tasks": {
    "items": {
      "properties": {
        "agentId": {
          "enum": ["ag_pm", "ag_designer", "ag_mock_builder", "ag_reviewer"]
        }
      }
    }
  }
}
```

`enum` 只包含当前群聊的**非 Orchestrator** 成员，每次动态生成。

### 3. 提示词改进

- 增加 `<allowed_agent_ids>["ag_pm","ag_designer",...]</allowed_agent_ids>` 白名单
- 删除硬编码的 `ag_mock_builder`、`ag_pm` 示例
- 删除 `<设计师 id>`、`<前端 id>` 等占位符（易被模型照抄）
- 示例计划改用当前群聊真实 ID 动态生成
- 增加 `NEEDS_CLARIFICATION` / `READY_TO_PLAN` 行为提示
- Recovery 阶段不再看到其他会话的 Agent

### 4. 三层防护保留

| 层 | 机制 | 说明 |
|----|------|------|
| 1 | `enum` 约束 | DeepSeek JSON 模式下强制 agentId 只能是列表值 |
| 2 | 工具校验 | plan_tasks handler 即时校验 + 别名自动纠正 |
| 3 | 审批 Gate | compileAndValidateDispatchPlan 再次校验 |

## 教训

1. **AdapterInput 有两个 system prompt 字段**：`agent.systemPrompt` 和 `systemPrompt`。
   adapter 使用的是 `input.systemPrompt`，不是 `agent.systemPrompt`。
   把动态 prompt 写到 `agent.systemPrompt` 是静默 bug——不会报错，但 LLM 收不到。

2. **不要信任 LLM 会遵守文本约束**。DeepSeek 等经济型模型对"请从列表中选择"的
   执行能力很弱。`enum` 比文本可靠得多。

3. **提示词里不要写占位符**。`<设计师 id>` 这种格式会被模型当成模板照抄，
   而不是理解成"需要替换为实际值"。

## 相关文件

- `src/server/orchestrator-service.ts`
- `src/server/adapters/custom-agent-adapter.ts`
- `src/server/adapters/types.ts`
- `src/server/tools/orchestrator-tools.ts`
