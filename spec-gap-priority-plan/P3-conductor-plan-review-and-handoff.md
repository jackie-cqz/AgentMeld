# P3 - Conductor Plan Review 与 Task Handoff

## 对应 specs

- `specs/02-stream-events.md`
- `specs/06-conductor-flow.md`
- `specs/16-task-contract-handoff.md`
- `specs/17-conductor-plan-review.md`

## 当前问题

当前有 Conductor 骨架：

- `src/server/conductor-service.ts`
- `src/server/tools/conductor-tools.ts`
- `src/server/dispatch-plan-manager.ts`
- `src/app/api/dispatch-plans/[id]/resolve/route.ts`

但目前不是 spec 要求的工作流：

- `executeConductor()` 没接入 AgentRunner。
- Conductor 没有通过真实 adapter 调用 `plan_tasks` 来生成 plan。
- 当前 `buildDemoPlan()` 是 demo 计划。
- plan review UI 不存在。
- child run 没有真正使用 parentRunId。
- child task 完成状态没有读取 `report_task_result`，现在基本等同 run 结束即 complete。
- `expectedOutputs`、`inputs`、`acceptanceCriteria` 虽在类型/工具 schema 里出现，但没有完整编译、绑定 artifact、验收语义。

## 需要做的内容

1. AgentRunner 接入 Conductor 模式。
   - 当 agent.isConductor 时，不走普通回复流程，进入 conductor stage。
   - Conductor stage 使用当前 agent adapter 调用 LLM，并强制提供 `plan_tasks`。
   - 捕获 `plan_tasks` 后停止继续消费 plan 阶段输出。

2. 实现 plan compiler。
   - 保留 explicit dependsOn。
   - 根据 `inputs.fromTaskId` 补依赖。
   - 可选保留文本启发式依赖推断。
   - 去重并保持顺序。

3. 实现 plan validator。
   - 空 plan、重复 task id、不可用 agent、conductor recursion。
   - unknown dependency、duplicate dependency、self dependency、cycle。
   - expectedOutputs.id 在同 task 内重复。
   - inputs 引用 missing/self/unknown output。

4. Plan review。
   - 注册 pending plan。
   - 发布 `dispatch.plan.pending`。
   - UI 显示 read-only plan，支持 approve/reject。
   - revise 按 Spec 17 走 conversational feedback，不提交结构化 plan。
   - approve 时重新 compile/validate。
   - 发布 `dispatch.plan` 后才进入执行。

5. DAG 执行。
   - 支持 waves 并发。
   - 加全局并发上限。
   - 子 run 的 parentRunId 指向 conductor run。
   - dispatch.start 只在真正拿到并发槽后发布。
   - 上游失败时 downstream skipped。

6. Task handoff。
   - `write_artifact` 支持 `outputKey`。
   - AgentRunner 记录 `taskId.outputKey -> artifactId`。
   - child prompt 注入 `<required_inputs>` 和 `<expected_outputs>`。
   - required input 缺失时跳过 child task。
   - child 必须调用 `report_task_result`。
   - acceptanceCriteria 缺失或 failed 时任务 failed。

7. 聚合。
   - Conductor 汇总真实 task results。
   - failed/blocked/skipped 明确写入消息。
   - 不把 child run complete 直接当语义 complete。

## Conductor 加固详细计划

### 设计目标

Conductor 不是“多启动几个 Agent”的快捷入口，而是一个三阶段工作流：

```text
PLAN -> REVIEW -> EXECUTE -> AGGREGATE
```

每个阶段都需要有清晰的暂停点、失败语义和可见 UI。

### Stage 0. 触发条件

触发 Conductor 的条件：

- conversation.mode === "group"
- 用户没有明确 @ 某个非 Conductor agent
- conversation.agentIds 中存在 isConductor=true 的 agent

如果用户 @ 了具体 worker：

- 只启动被 @ 的 worker。
- 不进入 Conductor。

如果用户 @ 了 Conductor：

- 进入 Conductor。

### Stage 1. PLAN

当前 `buildDemoPlan()` 必须被真实 plan stage 替代。

建议流程：

1. AgentRunner 创建 Conductor parent run。
2. 构造 Conductor prompt：
   - 用户原始消息。
   - conversation 最近公开上下文。
   - pinned messages。
   - 当前可用 agents 列表。
   - 每个 agent 的 capabilities、toolNames、description。
   - 可用 artifact 摘要。
3. 给 Conductor adapter 注入 `plan_tasks` 工具。
4. 消费 stream。
5. 捕获 `tool.call` 且 toolName === `plan_tasks`。
6. 解析 tool args。
7. 停止消费后续 plan 阶段输出，防止 Conductor 在 review 前继续执行。
8. compile + validate。
9. 注册 pending review。
10. 发布 `dispatch.plan.pending`。

如果没有调用 `plan_tasks`：

- parent run failed。
- 创建可见错误消息。
- 不启动 child runs。

### Stage 2. REVIEW

Pending plan 是用户确认边界，不能跳过。

后端：

- `registerPendingPlan(conversationId, runId, plan)`。
- 绑定 AbortSignal。
- run abort 时自动 reject/cancel pending plan。

REST API 应按 Spec 17 调整为 conversation-scoped：

```text
GET  /api/conversations/:id/pending-dispatch-plans
POST /api/conversations/:id/pending-dispatch-plans/:planId
```

POST body：

```ts
{ action: "approve" }
{ action: "reject" }
{ action: "revise"; feedback: string }
```

注意：Spec 17 要求 revise 是自然语言反馈，不是提交结构化 revisedPlan。当前已有的 `action: "revise", revisedPlan` 更像结构化编辑，需要改成 feedback 语义，或明确当前先做 approve/reject，revise 后置。

前端：

- `DispatchPlanReviewCard`
- 只读展示 task。
- 按 task 显示 agent、dependsOn、inputs、expectedOutputs、acceptanceCriteria。
- approve/reject 按钮。
- 如果支持 revise，composer 在 pending plan 时切换为“发送修改意见”。

### Stage 3. EXECUTE

执行前必须再次 compile/validate。

DAG 执行要求：

- topological waves。
- 全局并发上限，例如 3。
- task 等待并发槽时 UI 状态为 pending。
- 拿到槽位后发布 `dispatch.start`。
- 启动 child run 时传 `parentRunId`。
- child trigger message 应该是内部 task prompt，不一定作为普通用户消息展示；如果展示，需要明确 role/user 且 parentMessageId 指向原始用户消息。

### Child prompt 构造

建议函数：

```ts
buildChildTaskPrompt(task, context): string
```

包含：

```xml
<task>
  <id>t1</id>
  <title>...</title>
  <instructions>...</instructions>
</task>

<required_inputs>
  <input fromTaskId="t0" outputId="prd" artifactId="art_xxx" type="document" required="true" />
</required_inputs>

<expected_outputs>
  <output id="ui_spec" type="document" required="true">...</output>
</expected_outputs>

<acceptance_criteria>
  <item>...</item>
</acceptance_criteria>

<reporting>
  Call report_task_result exactly once before finishing.
</reporting>
```

规则：

- required input artifact 不存在时，不启动 child run，task skipped。
- optional input 不存在时，在 prompt 中标记 missing。
- expected output 要求 child 调 `write_artifact` 时带 `outputKey`。
- child 必须调用 `report_task_result`。

### Task result 捕获

当前 `report_task_result` handler 只返回 acknowledged。需要让 AgentRunner 能捕获 child run 内的 report。

可选实现：

1. 在 ToolContext 增加 `dispatchTaskId`、`parentRunId`。
2. `report_task_result` handler 将结果写入 in-memory task result registry。
3. AgentRunner child run 完成后读取 registry。
4. 没有 report -> failed。

建议新增：

- `src/server/dispatch-task-results.ts`
- `src/server/dispatch-task-results.test.ts`

状态：

```ts
interface DispatchTaskReport {
  taskId: string;
  runId: string;
  status: "complete" | "failed" | "blocked";
  summary: string;
  acceptanceResults: Array<{ criterion: string; passed: boolean; evidence: string }>;
  blockers: string[];
  artifacts: Record<string, string>;
}
```

### Artifact output binding

Spec 16 task handoff 要求 `write_artifact` 支持 `outputKey`。

改动：

- `write_artifact` args 加 `outputKey?: string`。
- 返回中包含 `outputKey`。
- AgentRunner 监听 child run artifact create。
- 如果有 outputKey，绑定 `taskId.outputKey -> artifactId`。
- 如果 task 只有一个 required expected output，且 child 只产出一个 artifact，可以兼容自动绑定。

验证：

- duplicate outputKey 不允许。
- unknown outputKey warning 或 failed，按严格程度决定。

### Failure semantics

任务状态应来源于语义 report，而不是 run 状态。

规则：

- child run failed/aborted -> task failed/aborted。
- child run complete but no report_task_result -> task failed。
- report status failed/blocked -> dispatch.end failed。
- acceptanceCriteria 中任一缺失或 passed=false -> failed。
- upstream failed -> downstream skipped。
- required input missing -> skipped。

### Aggregation

聚合消息应包含：

- 总任务数。
- complete/failed/skipped 数。
- 每个 task 的 agent、状态、summary。
- artifacts output map。
- blockers。
- 用户下一步建议。

后续可以让 Conductor LLM 生成最终总结，但 MVP 可以先 deterministic summary。

### 并发与中止

建议新增：

- `src/server/dispatch-concurrency.ts`

行为：

- 全局 semaphore。
- Abort parent run 时：
  - pending plan reject。
  - waiting tasks 不启动。
  - running child runs abort。
  - dispatch.end 发布 aborted/skipped。
  - parent run aborted。

### 测试清单

- Conductor 未调用 plan_tasks -> parent failed。
- plan duplicate task id -> failed，不进入 review。
- approve 后发布 dispatch.plan 再启动 child runs。
- reject 后无 child runs。
- child run parentRunId 正确。
- DAG wave 顺序正确。
- 并发上限生效。
- upstream failed 后 downstream skipped。
- required input missing 后 skipped。
- no report_task_result -> failed。
- acceptance failed -> failed。
- outputKey 绑定 artifactId。
- parent abort 取消 pending plan 和 child runs。

## 验收标准

- 群聊未 @ 指定时，Conductor 进入 plan review，而不是普通文本回复。
- 前端出现 pending plan 卡片。
- approve 后启动 child runs。
- reject 后不启动 child runs。
- child runs 的 parentRunId 正确。
- downstream required input 缺失时 skipped。
- child 未调用 `report_task_result` 时 failed。
- acceptance criteria 不通过时 failed。
- 聚合消息反映真实结果。

## 不在本优先级范围

- 不做拖拽式 DAG 编辑。
- 不持久化 pending plan。
- 不引入 LangGraph 等 workflow 框架。
