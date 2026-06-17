# P2 - Orchestrator 证据门禁与失败恢复

## 目标

让 Orchestrator 子任务执行结果可信。子 Agent 必须通过 `report_task_result` 汇报状态、验收项、证据和产物；Orchestrator 根据报告决定完成、失败、重试、跳过或汇总。

## 当前缺口

当前 `orchestrator-service.ts` 中如果子任务没有 report，会自动记录 complete。这对 demo 友好，但对真实多 Agent 协作不可靠。冲突检测也还是 placeholder。

## 参考文件

- `src/server/orchestrator-service.ts`
- `src/server/tools/orchestrator-tools.ts`
- `src/server/dispatch-task-results.ts`
- `src/server/child-prompt-builder.ts`
- `src/server/dispatch-concurrency.ts`
- `specs/16-task-contract-handoff.md`
- `openspec/changes/harden-orchestrator-evidence-gates/`
- `openspec/changes/add-task-contract-artifact-handoff/`

## 具体任务

1. 取消无 report 自动成功。
   - 没有 `report_task_result` 时标记为 failed 或 blocked。
   - aggregate message 中明确写出“未提交任务报告”。

2. 强化 `report_task_result` schema。
   - `status` 必填。
   - `summary` 必填。
   - acceptanceResults 对每条 acceptanceCriteria 给出 passed/evidence。
   - expectedOutputs 中 required=true 的输出必须存在或说明 blocker。

3. 补齐 task contract handoff。
   - `plan_tasks` 支持 `expectedOutputs`、`inputs`、`acceptanceCriteria`。
   - `inputs.fromTaskId` 自动加入 `dependsOn`，稳定去重。
   - 校验 expected output id 不能在同一 task 内重复。
   - 校验 input 引用的 upstream task 和 output key 必须存在。
   - required input 缺失时，下游任务在启动前 `skipped`。

4. 支持 `write_artifact.outputKey`。
   - `write_artifact` 接受可选 `outputKey`。
   - 子任务创建 artifact 后，将 `taskId.outputKey` 绑定到真实 artifactId。
   - 如果一个任务只有一个 required expected output 且只产出一个 artifact，可兼容性自动绑定。

5. 实现 retry / replan 策略。
   - 读取 task 的 `maxAttempts`。
   - 失败后将上一次错误和缺失证据放进 retry prompt。
   - 超过次数后进入 failed。
   - 对齐 Spec 06：避免无限重试；必要时由 Orchestrator 做补救 replan。

6. 实现更真实的冲突检测。
   - 记录每个 child run 的文件写入路径。
   - 同一 wave 中多个 task 写同一文件时标记 conflict。
   - 后续 wave 依赖前置任务时允许顺序写入，但要在总结里展示覆盖风险。

7. 改进 aggregate message。
   - 展示每个 task 的 attempts、状态、证据摘要、产物链接。
   - 展示 blocked/skipped 的具体原因。
   - Stage 3 最终应允许 Orchestrator 基于 task_results 再生成聚合消息，而不仅是模板总结。

## 验收标准

- 子任务不调用 `report_task_result` 时不会被误判完成。
- required output 缺失会导致任务失败或 blocked。
- retry 只针对失败任务触发，不重复执行已完成任务。
- 同 wave 文件冲突会被检测并展示。
- `expectedOutputs` / `inputs` / `outputKey` 能完成跨任务 artifact handoff。
- Orchestrator 总结可以作为一次协作运行的审计记录。
