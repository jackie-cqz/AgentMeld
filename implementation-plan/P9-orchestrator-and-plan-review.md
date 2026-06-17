# P9 - Orchestrator 与计划审批

## 目标

实现群聊中的 Orchestrator 基础工作流：规划任务、等待用户审批/修订、按 DAG 调度子 Agent、收集语义结果、聚合最终回复。

## 参考文件

- `openspec/specs/orchestrator/spec.md`
- `openspec/specs/tools/spec.md`
- `openspec/specs/conversation-context/spec.md`
- `specs/06-orchestrator-flow.md`
- `specs/16-task-contract-handoff.md`
- `specs/17-orchestrator-plan-review.md`
- `openspec/changes/add-orchestrator-plan-review/*`
- `openspec/changes/add-task-contract-artifact-handoff/*`
- `openspec/changes/add-dispatch-harness-loop/*`
- `openspec/changes/harden-orchestrator-evidence-gates/*`
- `AGENT_BACKEND.md` 第 7、8、9、10、11、12 章

## 范围

需要实现：

- `plan_tasks` 工具
- `report_task_result` 工具
- dispatch plan parser/compiler/validator
- pending dispatch plan queue
- plan review UI card
- DAG executor
- child task prompt builder
- aggregate prompt builder

## UI 组件级实现计划

### UI 参考图对齐

参考图：`agent-conference-preview.png`。

P9 的 Orchestrator UI 应对齐截图中间聊天流里的 Orchestrator 消息：

- Orchestrator 不应该打开独立流程页，它的计划、思考、总结都应留在聊天流中。
- Orchestrator 消息有头像 `OR`、名称、时间、token 用量。
- “思考”内容默认折叠，使用弱边框/虚线块。
- 总结可以用结构化表格呈现，例如“项目 / 状态”。
- 完成状态使用明确的文本和轻量图标，例如“任务已完成”“问题已确认解决”。
- 用户确认类消息靠右，Orchestrator 随后在左侧回复。

### 页面区域

P9 的 UI 不新增独立页面，而是在 ChatPanel 中把 Orchestrator 的计划和调度状态渲染成结构化卡片。用户应当像处理群聊消息一样审阅、批准或修订计划。

```text
ChatPanel
  MessageTimeline
    DispatchPlanReviewCard
    DispatchProgressCard
    DispatchTaskCard
  MessageComposer
    PlanRevisionComposerMode
  PendingApprovalsStrip
    PendingDispatchPlanIndicator
```

### `DispatchPlanReviewCard`

职责：

- 渲染 `dispatch.plan.pending`。
- 展示计划摘要、任务列表、依赖关系、预期输出、验收标准。
- 提供 approve / revise / reject 操作。

状态来源：

- `appStore.pendingDispatchPlans[pendingId]`
- `appStore.agents`

展示区域：

| 区域 | 内容 |
|---|---|
| Header | Orchestrator 名称、计划状态、任务数量 |
| Summary | plan summary / goal |
| TaskList | 每个 task 的标题、agent、依赖、输出、验收 |
| DependencyHints | 依赖关系简表 |
| Actions | Approve、Revise、Reject |

视觉：

- 卡片放在 Orchestrator 消息体内，而不是全屏遮罩。
- 任务列表紧凑排列，适合在聊天列宽度内阅读。
- 关键风险或缺失依赖用轻量 warning 样式。

交互：

- Approve 调 resolve API。
- Reject 调 resolve API 并给出拒绝理由输入。
- Revise 进入 composer revision mode。

API：

- `POST /api/dispatch-plans/[id]/resolve`

验收：

- pending plan 未处理前子任务不显示 running。
- approve 后 card 状态变为 approved。
- reject 后 card 状态变为 rejected。

### `PlanTaskList`

职责：

- 以可扫描方式展示 DAG 任务。
- 不实现拖拽编辑，revision 走自然语言反馈。

字段：

| 字段 | 显示方式 |
|---|---|
| `taskId` | 小号 monospace |
| `title` | 主标题 |
| `agentId` | agent chip |
| `dependsOn` | dependency chips |
| `inputs` | `fromTask.outputId` chips |
| `expectedOutputs` | output chips |
| `acceptanceCriteria` | checklist count 或展开列表 |

验收：

- 任务多时可滚动或折叠。
- unknown agent 显示错误态。

### `PlanRevisionComposerMode`

职责：

- 当用户点击 Revise 后，普通 MessageComposer 切换成计划修订模式。
- 用户输入的反馈作为普通 user message 持久化和广播，但不启动新的普通 run。

UI 状态：

```ts
type ComposerMode =
  | { type: 'normal' }
  | { type: 'plan_revision'; pendingPlanId: string; runId: string }
```

交互：

- 输入框 placeholder 改成“说明你希望如何调整计划”。
- 发送按钮文案改成“提交修订”。
- 可取消 revision mode。

参考：

- `specs/17-orchestrator-plan-review.md` 的 Conversational Revision。

验收：

- revise feedback 出现在消息流中。
- 不创建新的普通 AgentRun。
- Orchestrator 重新进入 plan stage 并生成新 pending plan。

### `DispatchProgressCard`

职责：

- 展示 approved plan 的执行进度。
- 汇总 completed/running/failed/skipped。
- 在聊天流中显示为 Orchestrator 消息的一部分，和普通总结共存。

状态来源：

- `dispatch.task.*` events
- `agentRuns`

展示：

| 状态 | 视觉 |
|---|---|
| pending | 灰色 |
| running | 进度/脉冲 |
| complete | 成功 |
| failed | 错误 |
| skipped | 弱化 |

验收：

- 上游失败后下游 skipped 原因可见。
- 所有任务终态后显示 aggregate 阶段状态。

### `DispatchTaskCard`

职责：

- 展示单个子任务的执行详情。
- 折叠显示，默认只展示摘要。

字段：

- task title
- assigned agent
- status
- attempts
- acceptance results
- blockers
- produced artifacts
- linked child run id

交互：

- 点击展开详情。
- 点击 produced artifact 打开 P6 preview panel。
- 点击 child run 可定位到对应 agent message。

验收：

- failed task 显示失败原因。
- blocked report 显示 blocker。
- acceptance criteria missing/failed 明确标出。

### `PendingDispatchPlanIndicator`

职责：

- 在 ChatPanel 顶部或 composer 上方提示“有计划待审批”。
- 当用户滚动离开 plan card 时仍能快速回到待审批卡片。

交互：

- 点击滚动到 `DispatchPlanReviewCard`。
- resolved 后自动消失。

### `AggregateResultMessage`

职责：

- Orchestrator 聚合完成后仍以普通 agent message 渲染。
- 其中可包含 text、artifact_ref、tool_result 等正常 parts。

UI 要求：

- 不为 aggregate 单独发明消息模型。
- 可在 message header 上显示“Orchestrator 总结”。
- 支持表格渲染，用于呈现参考图中的“项目 / 状态”总结。
- 支持 checklist/status line，用于展示修复项、验收项、当前状态。

## Orchestrator 生命周期

```text
用户群聊发消息且无 @
  -> responder = orchestrator
  -> plan stage
  -> dispatch.plan.pending
  -> 用户 approve / revise / reject
  -> DAG child runs
  -> child report_task_result
  -> aggregate stage
  -> final message
```

## Dispatch Plan 关键字段

参考 `specs/16-task-contract-handoff.md`：

- `taskId`
- `agentId`
- `title`
- `prompt`
- `dependsOn`
- `inputs`
- `expectedOutputs`
- `acceptanceCriteria`
- `maxAttempts`

## 任务拆分

1. 定义 plan schema 和 zod parser。
2. 编译 plan：补依赖、去重、稳定排序。
3. 校验 plan：空计划、重复 id、未知 agent、循环依赖、自依赖。
4. 发布 `dispatch.plan.pending`。
5. 实现 approve/revise/reject API。
6. 实现 DAG 分波执行。
7. 子 run 使用 isolated task prompt，不注入普通全局历史。
8. 子任务必须调用 `report_task_result`。
9. 缺失 required input 时跳过下游。
10. 聚合阶段总结所有 task 状态。

## 验收标准

- 群聊无 @ 会触发 Orchestrator。
- Plan 出现前不会启动子任务。
- 用户批准后才执行 DAG。
- 用户修订会生成新 plan。
- 循环依赖被拒绝。
- 上游失败会导致下游 skipped。
- 子任务未报告语义结果会被视为 failed。
- 最终回复包含 completed/failed/skipped 摘要。

## 风险

- Orchestrator 是最容易膨胀的模块，MVP 先用 Mock/基础 Custom 跑通，暂缓复杂自动重规划。
- Plan review pending 不落 SQLite，dev server 重启会丢，这是 spec 17 的明确 non-goal。
