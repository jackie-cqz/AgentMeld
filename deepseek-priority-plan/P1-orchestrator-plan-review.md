# P1 - Orchestrator 计划审批闭环

## 目标

把 Orchestrator 从“生成计划后自动执行”改成“生成计划 -> 发送 pending plan -> 用户审批/会话式修改/拒绝 -> 再执行”的完整产品闭环。

## 当前缺口

`src/server/orchestrator-service.ts` 已导入 `registerPendingPlan`，前端和 API 也已有 `dispatch.plan.pending` / `dispatch.plan.resolved` 相关结构，但当前执行流仍然写着 `auto-execute without waiting for approval`。

## 参考文件

- `src/server/orchestrator-service.ts`
- `src/server/dispatch-plan-manager.ts`
- `src/app/api/dispatch-plans/[id]/resolve/route.ts`
- `src/components/pending-approval-panel.tsx`
- `src/stores/app-store.ts`
- `specs/06-orchestrator-flow.md`
- `specs/17-orchestrator-plan-review.md`
- `openspec/changes/add-orchestrator-plan-review/`

## 具体任务

1. 在 `executeOrchestrator` 中接入 `registerPendingPlan`。
   - 计划生成后先注册 pending plan。
   - 发布 `dispatch.plan.pending`。
   - await 用户结果。

2. 对齐 Spec 06 的 plan 阶段。
   - Orchestrator 计划阶段应通过 `plan_tasks` 结构化输出，而不是绕开工具协议直接执行。
   - 捕获 `tool.call('plan_tasks')` 后停止消费 plan 阶段后续输出。
   - 运行 `compileDispatchPlan` 和 `validateDispatchPlan` 后再发布 pending。
   - 审批通过后发布正式 `dispatch.plan`，作为执行开始事件。

3. 支持三种用户决策。
   - `approve`：按原计划执行。
   - `revise`：用户用自然语言描述修改意见，Orchestrator 重新规划，新的 plan 再进入 review。
   - `reject`：终止 Orchestrator run，并生成清晰总结。

4. 修正计划 UI 语义。
   - 对齐 `specs/17-orchestrator-plan-review.md`：计划卡片默认只读。
   - 不做结构化 DAG 表单编辑作为首版路径。
   - 修改计划通过 composer 输入自然语言 feedback。
   - pending 期间 composer 不启动新 run，而是路由到 plan revise API。

5. 计划审批需要超时/恢复策略。
   - 暂时可以不自动超时，但页面刷新后必须还能看到 pending plan。
   - 如果 dev server 重启导致内存 resolver 丢失，UI 应提示该 pending 已失效。

6. API 路径对齐 Spec 17。
   - `GET /api/conversations/:id/pending-dispatch-plans`
   - `POST /api/conversations/:id/pending-dispatch-plans/:planId`
   - body 支持 `{ action:'approve' }`、`{ action:'reject' }`、`{ action:'revise', feedback:string }`。

7. 对齐参考图中的 Orchestrator 消息形态。
   - Orchestrator 输出应作为聊天流中的普通 agent message 展示，而不是独立弹窗。
   - thinking 内容显示为消息内折叠块，样式接近参考图中的虚线浅灰区域。
   - 总结内容支持 markdown 表格、列表、状态图标和 artifact/deployment 链接。
   - Orchestrator 名称、avatar、时间和 token usage 显示在消息头部。
   - plan review 卡片挂在同一条 Orchestrator 消息附近，用户能在聊天上下文里审批。

## 验收标准

- Orchestrator 生成计划后不会自动执行。
- UI 中能看到计划详情和每个 task。
- 用户 approve 后才开始 dispatch。
- 用户 reject 后 run 结束，不创建子任务。
- 用户 revise 后会生成新计划并重新进入 review，而不是直接提交结构化计划。
- `dispatch.plan.pending`、`dispatch.plan.resolved`、`dispatch.plan` 三类事件顺序正确。
- Orchestrator 的计划、思考、总结都在中间聊天流内自然呈现，符合 `agent-conference-preview.png` 的 IM 工作台风格。
- 有测试覆盖 approve/reject/revise 三条路径。
