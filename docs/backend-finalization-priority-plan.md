# AgentMeld 后端最终收尾目标与优先级计划

> 文档状态：当前有效  
> 编写日期：2026-06-22  
> 当前基线：后端综合完成度约 90%  
> 目标范围：Web 本地运行 + SQLite + DeepSeek / OpenAI-compatible Custom Agent

## 1. 文档目的

本文档用于指导 AgentMeld 后端从“核心功能已经可用”进入“可靠、可诊断、可恢复、可发布”的最终收尾阶段。

当前项目已经完成消息、DeepSeek Tool Loop、多 Agent DAG 调度、任务证据校验、审批、Artifact、Workspace、上下文压缩、部署和搜索等核心能力。后续工作不应重新实现这些模块，而应集中解决以下问题：

1. Run 详情接口仍会遗漏已结束的子 Run，并可能查询错误的 Plan 输出绑定。
2. Conductor 的 task attempt、Recovery Plan 和恢复关系还没有完整持久化。
3. 服务重启后只能把失联任务标记为 interrupted，不能基于已完成结果创建新的恢复运行。
4. 错误分类、结构化日志和诊断 API 尚未贯穿全部执行链路。
5. DeepSeek、重启恢复、审批竞态和数据库升级仍缺少最终级别的集成验收。
6. `AGENT_BACKEND.md`、编号 Spec、OpenSpec 与当前实现存在部分漂移。

本文档将剩余任务拆为 P0-P5 六个优先级。完成 P0-P2 后，后端可达到约 95%；完成 P0-P5 后，当前限定范围内可视为 100%。

---

## 2. 产品范围

### 2.1 计入完成度

- Next.js Route Handler 后端。
- SQLite + `better-sqlite3` 本地持久化。
- DeepSeek / OpenAI Chat Completions-compatible Custom Agent。
- 单聊、群聊和 Conductor。
- Agent Tool Loop、工具审批和用户结构化提问。
- Workspace 文件系统、Artifact、附件、部署和搜索。
- 对话历史、Pinned Message、上下文预算和压缩任务。
- EventBus + SSE 实时增量。
- 服务重启后的状态修复和可审计恢复。

### 2.2 明确不计入

- Claude Code SDK Adapter 的真实执行。
- Codex SDK Adapter 的真实执行。
- Electron 桌面端。
- Capacitor 移动端。
- 外部 MCP Server。
- 多用户权限、云端数据库和分布式任务队列。
- 在 LLM token 流中间或 Bash 进程执行一半时进行断点续跑。

Claude/Codex stub 可以保留，但其未实现状态不阻塞本计划完成。

---

## 3. 当前基线

### 3.1 已验证质量状态

截至 2026-06-22，当前工作区验证结果：

- `pnpm exec vitest run --reporter=dot`：46 个测试文件、429 个测试全部通过。
- `pnpm exec tsc --noEmit --pretty false`：通过。
- `node node_modules/next/dist/bin/next build`：生产构建通过。
- 后端范围 ESLint：0 error、32 warning。

### 3.2 已完成能力

以下能力已经存在，后续优先级只做加固和补齐：

- 用户消息入库、Responder 选择和 AgentRun 创建。
- DeepSeek 流式文本、reasoning、usage 和多轮 Tool Calling。
- `fs_list`、`fs_read`、`fs_write`、`bash`。
- `read_artifact`、`write_artifact`、`deploy_artifact`、`deploy_workspace`。
- `read_attachment`、`ask_user`、`plan_tasks`、`report_task_result`。
- 写文件、Bash、用户问题和计划审批。
- Conductor Plan 编译、Agent ID 校正、DAG 波次执行和并发限制。
- 任务报告、Acceptance Criteria、工具证据和 Artifact output binding。
- 同一 wave 文件冲突检测、Recovery Plan 和 Aggregate。
- Conversation history、Pinned、Token Budget 和上下文压缩。
- 压缩任务持久化、并发保护、终止、重试和启动恢复。
- Artifact 版本、静态预览、部署和消息搜索。
- Run、审批和压缩任务的孤儿状态启动清理。
- 初步结构化 Logger、Provider 错误分类和 Run 详情 API。

### 3.3 剩余差距概览

| 领域 | 当前状态 | 主要差距 |
|---|---|---|
| Run 诊断 | 已有 `/api/runs/[id]` | 已结束子 Run 可能缺失，绑定查询依赖固定 Plan ID |
| Conductor 持久化 | Plan、任务结果、绑定、冲突已入库 | attempt 会覆盖，Recovery Plan 没有完整版本记录 |
| 重启恢复 | 能标记失联 Run/审批/压缩任务 | 不能创建关联的新 Recovery Run |
| 错误模型 | 有 Logger 和部分分类 | Adapter、Tool、审批、Conductor 尚未统一贯通 |
| DeepSeek 验收 | 已有 mock 与集成测试 | 需要补齐协议异常、重启和幂等组合场景 |
| 文档 | 主文档较完整 | 部分行号、状态描述和数据库规格已过时 |

---

## 4. 最终架构原则

### 4.1 SQLite 是可恢复状态的唯一来源

必须持久化：

- Run 生命周期和最后错误。
- Conductor Plan revision。
- 每个 task 的每次 attempt。
- output binding。
- 文件冲突。
- 审批审计状态。
- 上下文压缩任务。
- 新 Recovery Run 与原 Run 的关系。

只允许存在于内存：

- 当前进程的 `AbortController`。
- 正在等待用户操作的 Promise resolver。
- 当前进程内短期 EventBus 回放缓冲。
- 当前 Tool Loop 的临时 SDK 对话数组。

### 4.2 重启恢复不是原地续跑

正确恢复语义：

1. 将旧 `running` Run 标记为 interrupted。
2. 保留已经成功持久化的 task、Artifact、审批和 output binding。
3. 不恢复旧 LLM stream、Tool Loop 或 Bash 子进程。
4. 用户触发恢复时创建一个新的 Run。
5. 新 Run 通过 `resumedFromRunId` 或等价字段关联旧 Run。
6. 新 Run 根据旧 Plan 和已成功结果生成 Recovery Plan。

### 4.3 EventBus 不是持久化消息队列

- SSE 只传输当前进程的实时增量。
- 页面重载或 SSE 重连后，前端通过 bootstrap/API 从 SQLite 恢复状态。
- `Last-Event-ID` 只保证当前进程短时间断线重放。
- 不为当前本地单用户产品引入 Redis、Kafka 或远程队列。

### 4.4 错误必须可分类、可展示、可诊断

每个终止错误至少应包含：

- `category`
- `code`
- `message`
- `retryable`
- `stage`
- 关联 `runId`

用户可见消息不能包含密钥、完整 Authorization Header、附件原文或敏感命令参数。

---

# P0：修复 Run 诊断与持久化查询正确性

## 5.1 目标

先保证现有持久化数据能够被准确查询。后续的恢复、错误模型和测试都依赖可信的 Run 详情接口。

P0 不新增复杂业务能力，主要修复当前已经确定的查询错误、数据遗漏和诊断字段缺失。

## 5.2 当前问题

### 5.2.1 Run API 会遗漏已结束子 Run

当前：

- `src/app/api/runs/[id]/route.ts` 使用 `listChildRunIds(id)`。
- `src/server/repositories.ts` 中 `listChildRunIds()` 只查询 `status = 'running'`。

因此父 Run 完成后，已变成 `complete`、`failed` 或 `aborted` 的子 Run 不会出现在诊断接口中。

### 5.2.2 Output binding 查询写死初始 Plan ID

当前 Run API 使用：

```text
plan_<runId>_init
```

查询 output binding。这会遗漏：

- revise 后的新 Plan。
- Recovery Plan。
- 将来 revision 大于 1 的 Plan。
- 因 ID 规则变化产生的 Plan。

### 5.2.3 Task result 没有进入 Run 详情

数据库已有 `conductor_task_results`，但 Run API 没有返回：

- taskId。
- agentId。
- attempt。
- childRunId。
- status。
- summary。
- errorCategory。

### 5.2.4 Run 错误字段没有完整暴露

`agent_runs` 已有：

- `error_category`
- `retryable`
- `interrupted`

但 API 当前主要返回 `error` 和 `interrupted`，无法完整支持诊断页面。

### 5.2.5 计划详情不足

Run API 返回 Plan 元数据但不返回解析后的任务结构。开发者无法仅凭 API 判断：

- 实际批准的是哪一版 Plan。
- 每个 task 的依赖和 contract。
- Recovery Plan 与初始 Plan 的差异。

## 5.3 实施任务

1. 拆分子 Run 查询函数。
   - 保留 `listRunningChildRunIds()` 给中止逻辑使用。
   - 新增 `listChildRuns(parentRunId)` 返回全部状态。
   - 不要让诊断 API 复用只为 Abort 设计的查询。

2. 新增 Plan 级 output binding 查询。
   - 支持按 `conductor_run_id` 查询全部 binding。
   - 返回 `planId`、`producerTaskId`、`outputKey`、`artifactId`。
   - API 不再推导或拼接 Plan ID。

3. 新增 task attempt 查询。
   - 第一阶段可从现有 `conductor_task_results` 返回。
   - P1 完成表结构升级后，切换到独立 attempt 记录。

4. 完善 `GET /api/runs/[id]`。
   - Run 基础状态。
   - 全部子 Run。
   - 全部 Plan revision。
   - task attempts。
   - output bindings。
   - conflicts。
   - 关联审批摘要。
   - usage。
   - error category 和 retryable。

5. 对响应进行脱敏。
   - 不返回完整 system prompt。
   - 不返回 API Key。
   - 不返回完整附件内容。
   - 不返回可能包含密钥的完整 Bash command。

6. 修正 Run 详情 API 的类型。
   - 定义显式响应类型。
   - 避免大量 `Record<string, unknown>`。
   - 数据库行映射集中在 repository。

## 5.4 主要文件

- `src/server/repositories.ts`
- `src/app/api/runs/[id]/route.ts`
- `src/shared/types.ts`
- `src/server/run-recovery.ts`
- `src/server/agent-runner.ts`

## 5.5 测试

至少增加：

1. 父 Run 下包含 complete、failed、aborted、running 子 Run时，API 全部返回。
2. Abort 只影响 running 子 Run。
3. 初始 Plan、revise Plan 和 Recovery Plan 的 binding 均能查询。
4. Task result 能按 Run 返回。
5. API 返回 `errorCategory`、`retryable`、`interrupted`。
6. API JSON 不包含 API Key 或 Authorization Header。
7. 不存在的 Run 返回 404。

## 5.6 完成标准

- Run API 不遗漏任何终态子 Run。
- Output binding 不依赖硬编码 Plan ID。
- 一个 runId 足以查询当前已经持久化的所有 Conductor 状态。
- P0 测试、TypeScript、Lint 和 Build 通过。

---

# P1：完成 Conductor Plan Revision 与 Task Attempt 持久化

## 6.1 目标

让 Conductor 的执行历史成为真正的审计记录，而不是只保存最后一次 task 结果。

必须能够回答：

- 初始计划是什么？
- 用户 revise 后计划变成了什么？
- Recovery Plan 是什么？
- 某个 task 执行了几次？
- 每次 attempt 由哪个 child Run 执行？
- 哪次失败、哪次成功，原因是什么？

## 6.2 当前问题

### 6.2.1 Task attempt 会被覆盖

当前任务记录 ID 采用：

```text
<conductorRunId>_<taskId>
```

并使用 `INSERT OR REPLACE`。同一个 task 重试或恢复时可能覆盖之前记录。

当前主流程和 Recovery 流程多处把 `attempt` 固定写为 `1`。

### 6.2.2 Recovery Plan 没有完整持久化

初始/修订 Plan 会调用 `persistConductorPlan()`，但 LLM 生成的 Recovery Plan 需要作为独立 revision 保存，并记录：

- 来源 Plan。
- Recovery 原因。
- 对应失败任务。
- 创建阶段。
- 是否实际执行。

### 6.2.3 Plan 状态没有完整流转

建议状态：

```text
pending_review
approved
rejected
superseded
executing
complete
failed
interrupted
```

当前 Plan 记录主要是创建，缺少可靠状态更新和 `resolved_at`。

### 6.2.4 任务 contract 快照不完整

Task attempt 应关联当时执行的任务 contract：

- task 文本。
- dependsOn。
- inputs。
- expectedOutputs。
- acceptanceCriteria。
- requiredCommands。
- requiredEvidence。

否则计划后续被 revise 后，历史 attempt 的验收语义可能无法还原。

## 6.3 数据模型目标

推荐保留：

- `conductor_plans`
- `conductor_output_bindings`
- `conductor_conflicts`

将 `conductor_task_results` 明确升级为 attempt 表，或者新增：

```text
conductor_task_attempts
```

建议字段：

```text
id
conductor_run_id
plan_id
task_id
attempt
agent_id
child_run_id
status
task_contract_json
report_json
evidence_json
error_category
error
started_at
finished_at
created_at
updated_at
```

唯一约束：

```text
(conductor_run_id, plan_id, task_id, attempt)
```

## 6.4 实施任务

1. 为每版 Plan 分配稳定 ID 和 revision。
   - 初始 Plan revision 0。
   - 用户 revise 后 revision 递增。
   - Recovery Plan 继续递增，不另建不相关编号体系。

2. 持久化所有 Plan 类型。
   - 初始 Plan。
   - 用户 revise Plan。
   - Recovery Plan。

3. 实现 Plan 状态更新 repository。
   - 条件更新当前状态。
   - 写入 `resolved_at`。
   - revise 时旧 Plan 标记 `superseded`。

4. 每次 child Run 启动前创建 attempt。
   - 先写 `running`。
   - childRunId 生成后立即绑定。
   - 完成后条件更新为终态。

5. 重试必须创建新 attempt。
   - 不覆盖旧记录。
   - `attempt` 从 1 递增。
   - Recovery Plan 中 task ID 与旧 task ID 相同也不能覆盖。

6. 保存结构化报告和证据。
   - `report_task_result` 原始结构化结果。
   - Acceptance Results。
   - 文件写入证据。
   - required command 结果。
   - Artifact binding。

7. 建立 Plan 和 attempt 的关系。
   - 每个 attempt 必须有 `planId`。
   - conflict 必须关联实际发生冲突的 Plan。
   - output binding 必须关联产出它的 Plan 和 attempt。

8. 修正固定 Plan ID。
   - `persistConductorConflict()` 不再默认写初始 Plan。
   - `persistOutputBinding()` 接收当前真实 Plan ID。

## 6.5 主要文件

- `src/db/schema.ts`
- `src/db/bootstrap.ts`
- `src/server/repositories.ts`
- `src/server/conductor-service.ts`
- `src/server/agent-runner.ts`
- `src/server/task-result-report.ts`
- `src/server/dispatch-tool-evidence.ts`
- `src/shared/types.ts`

## 6.6 测试

1. 一个 task 首次失败、第二次成功，数据库保留两个 attempt。
2. revise 后旧 Plan 为 superseded，新 Plan 为 pending/approved。
3. Recovery Plan 有独立 revision 和来源关系。
4. 初始 task 和 Recovery task 使用相同 taskId 时不覆盖。
5. 每个 output binding 能追溯到 Plan、task 和 attempt。
6. 每个 conflict 能追溯到真实 Plan 和 wave。
7. 数据库升级在已有旧表时幂等执行。
8. 多次 bootstrap 不重复或破坏数据。

## 6.7 完成标准

- 任意 task 的每次执行都有独立 attempt。
- 初始、修订和 Recovery Plan 均可查询。
- 旧执行记录不会因重试被覆盖。
- task contract、报告和证据可以从数据库还原。

---

# P2：实现可审计的重启恢复与 Recovery Run

## 7.1 目标

在不承诺“原地断点续跑”的前提下，让服务重启后的 Conductor 工作可继续、可解释，并避免重复副作用。

P2 是后端从约 90% 提升到约 95% 的关键阶段。

## 7.2 当前行为

`src/server/run-recovery.ts` 当前会：

- 把 running Run 标记为失败并设置 `interrupted = 1`。
- 把 pending approval 标记为 interrupted/cancelled。
- 把压缩任务标记为 interrupted。
- 清理进程内 pending question、plan、file writes、task result 和 tool evidence。

这些行为能够避免“永远 running”，但不能继续之前的多 Agent 任务。

## 7.3 目标恢复语义

### 7.3.1 启动阶段

服务启动时：

1. 找到失联 Run。
2. 将 Run 标记为 interrupted。
3. 将运行中的 task attempt 标记为 interrupted。
4. 保留 complete attempt。
5. 保留 Artifact 和 output binding。
6. 将 pending approval 标记为 interrupted。
7. 不自动调用 DeepSeek。

### 7.3.2 用户恢复阶段

用户明确点击“恢复运行”或调用 API 后：

1. 校验旧 Run 是 interrupted/failed。
2. 读取最后批准的 Plan。
3. 读取所有 attempts、bindings、conflicts 和 Artifact。
4. 重新验证已 complete task 的证据是否仍存在。
5. 计算未完成、失败、被阻塞和待重做任务。
6. 创建新的 Conductor Run。
7. 新 Run 保存 `resumedFromRunId`。
8. 构建 Recovery Prompt。
9. 让 Conductor 生成修复计划并重新进入计划审批。

### 7.3.3 不允许恢复的内容

- LLM 输出到一半的 token。
- Tool Loop 中未持久化的 SDK messages。
- 执行到一半的 Bash 进程。
- 仍等待 Promise resolver 的旧审批。
- 未落库的临时文件写入 Hash。

## 7.4 实施任务

1. 扩展 Run 恢复关系。
   - 在 `agent_runs` 增加 `resumed_from_run_id`，或建立等价关联表。
   - Run API 返回原 Run 和后续恢复 Run。

2. 将中间 attempt 标记为 interrupted。
   - 不再只处理父 `agent_runs`。
   - 不把 interrupted 与普通 provider failed 混为一类。

3. 新增恢复分析服务。

建议：

```text
src/server/conductor-recovery-service.ts
```

职责：

- 读取旧运行快照。
- 验证已完成结果。
- 生成恢复输入。
- 创建新 Run。
- 不直接调用数据库以外的 UI 状态。

4. 新增恢复 API。

```text
POST /api/runs/:id/recover
```

返回 `202` 和新 runId。

5. 增加幂等保护。
   - 同一个 interrupted Run 同时只能创建一个 active recovery Run。
   - 重复请求返回已有 active recovery Run。

6. 防止重复副作用。
   - 已有 Artifact binding 的 complete task 默认不重跑。
   - 已成功执行且证据仍有效的 required command 不自动重跑。
   - 已执行的 Bash 不通过旧 approval 自动再次执行。
   - 文件存在不等于 task 自动成功，必须结合已保存证据。

7. 恢复计划重新审批。
   - Spec 17 的 pending plan Promise 不跨进程恢复。
   - 新 Run 生成新的 pending plan。
   - 用户重新批准后才执行。

8. 增加用户可见状态。
   - interrupted 原因。
   - 已保留完成任务数量。
   - 需要恢复任务数量。
   - 新旧 runId 关系。

## 7.5 主要文件

- `src/server/run-recovery.ts`
- `src/server/conductor-recovery-service.ts`
- `src/server/conductor-service.ts`
- `src/server/repositories.ts`
- `src/db/schema.ts`
- `src/db/bootstrap.ts`
- `src/app/api/runs/[id]/recover/route.ts`
- `src/app/api/runs/[id]/route.ts`
- `src/shared/types.ts`

## 7.6 测试

1. 重启后 running 父 Run 变为 interrupted。
2. running attempt 变为 interrupted，complete attempt 保持 complete。
3. pending approval 变为 interrupted，之后 approve 请求不能产生副作用。
4. 恢复 API 创建新 Run 并关联旧 Run。
5. 重复恢复请求只创建一个 active recovery Run。
6. 已完成 task 不重复执行。
7. 失败 task 进入 Recovery Prompt。
8. 丢失 Artifact 的 complete task 被重新判定为需要修复。
9. Recovery Plan 仍需用户审批。
10. 新 Recovery Run 再次失败时仍保留完整审计链。

## 7.7 完成标准

- 服务重启不会留下永久 running/pending。
- 用户可以从 interrupted Conductor Run 创建新的恢复运行。
- 已完成且证据有效的任务不会无条件重跑。
- 新旧 Run、Plan、attempt 和 Artifact 的关系可查询。

---

# P3：统一错误分类、结构化日志和诊断时间线

## 8.1 目标

让“Agent 没回复”“工具失败”“计划没有执行”“任务被跳过”等问题，可以通过 runId 在数据库和日志中快速定位。

## 8.2 当前问题

- `src/server/logger.ts` 已存在，但业务主链路仍有 `console.log/error/warn`。
- Provider 错误已有部分分类，但 Tool、审批、上下文、Conductor contract 没有统一模型。
- `agent_runs.error_category` 和 `retryable` 尚未在所有失败路径写入。
- 用户可见错误和开发诊断信息尚未完全分离。
- Run API 缺少按时间排序的统一事件/阶段摘要。

## 8.3 统一错误类别

建议固定为：

```text
provider_auth
provider_rate_limit
provider_timeout
provider_server
provider_invalid_response
tool_validation
tool_execution
approval_rejected
approval_interrupted
workspace_security
context_overflow
conductor_contract
conductor_dependency
conductor_evidence
run_aborted
run_interrupted
database
unknown
```

统一错误结构：

```typescript
interface BackendErrorDetail {
  category: BackendErrorCategory
  code: string
  message: string
  retryable: boolean
  stage?: string
  providerStatus?: number
  toolName?: string
  taskId?: string
  approvalId?: string
  cause?: string
}
```

## 8.4 实施任务

1. 完善 Logger Context。
   - conversationId。
   - runId。
   - parentRunId。
   - agentId。
   - planId。
   - taskId。
   - attempt。
   - stage。

2. 替换业务代码中的直接 console。
   - `agent-runner.ts`。
   - `run-recovery.ts`。
   - `conversation-context.ts`。
   - `conductor-service.ts`。
   - Adapter。

3. Provider 错误统一映射。
   - 401/403。
   - 408/Abort timeout。
   - 429。
   - 500/502/503。
   - 空 choices。
   - 无效 JSON/SSE。
   - 流中途断开。

4. Tool 错误统一映射。
   - Zod 参数错误。
   - 工具不存在。
   - Workspace 越权。
   - 审批拒绝。
   - 执行异常。

5. Conductor 错误统一映射。
   - 非法 Agent ID。
   - 非法 DAG。
   - 缺少 task report。
   - 缺少 required evidence。
   - 缺少 required input。
   - 文件冲突。
   - Recovery Plan 无效。

6. 保存结构化错误。
   - Run 保存 category/code/retryable。
   - attempt 保存 category/error。
   - Compaction job 复用同一类别。

7. 增加诊断时间线。
   - 可以由持久化状态动态组装，不必新增事件表。
   - 顺序展示 Run、Plan、attempt、approval、binding、conflict 和终态。

8. 完成脱敏。
   - key/token/authorization/password/cookie。
   - 完整 prompt 默认不记录。
   - 文件内容和附件内容不记录。
   - Bash command 默认只记录摘要或 Hash。

## 8.5 主要文件

- `src/server/logger.ts`
- `src/server/agent-runner.ts`
- `src/server/conductor-service.ts`
- `src/server/adapters/custom-agent-adapter.ts`
- `src/server/tools/registry.ts`
- `src/server/pending-writes.ts`
- `src/server/pending-bash.ts`
- `src/server/pending-questions.ts`
- `src/server/context-compaction-runner.ts`
- `src/app/api/runs/[id]/route.ts`

## 8.6 测试

1. DeepSeek 401 -> `provider_auth`，不可重试。
2. DeepSeek 429 -> `provider_rate_limit`，可重试。
3. timeout -> `provider_timeout`。
4. 无效 tool args -> `tool_validation`。
5. Workspace 逃逸 -> `workspace_security`。
6. 用户拒绝审批 -> `approval_rejected`。
7. 重启丢失 resolver -> `approval_interrupted`。
8. 缺少报告 -> `conductor_evidence`。
9. 日志和 API 中不出现测试 API Key。
10. 一个 runId 能组装完整诊断时间线。

## 8.7 完成标准

- 所有 Run 终态都有稳定错误分类或明确成功状态。
- 业务代码不依赖散落 console 作为唯一诊断方式。
- 一个 runId 可以串起模型、工具、审批、任务和恢复阶段。
- 日志与 API 不泄漏敏感信息。

---

# P4：补齐 DeepSeek、恢复与持久化端到端验收

## 9.1 目标

通过不依赖真实 API Key 的自动测试，证明正式支持的 DeepSeek 后端链路在成功、失败、重试、审批、重启和恢复场景下均符合预期。

## 9.2 DeepSeek 协议测试

本地 Mock Server 需要稳定覆盖：

- 普通文本流。
- reasoning content。
- usage。
- 单工具调用。
- 多工具调用。
- 多轮 Tool Loop。
- tool args 分片。
- 401、403、429。
- timeout。
- 500、502、503。
- 空 choices。
- 无效 JSON。
- SSE 中途断线。
- 达到最大 Tool Loop rounds。

## 9.3 完整消息链路测试

测试应真实经过：

```text
POST message
-> message persistence
-> AgentRun
-> CustomAgentAdapter
-> HTTP mock server
-> toolRegistry
-> MessagePart persistence
-> EventBus/SSE
-> run.end
```

断言：

- user message 只写一次。
- AgentRun 状态正确。
- tool_use/tool_result callId 配对。
- usage 累计正确。
- 最终 agent message 状态正确。
- Abort 后不继续执行下一轮工具。

## 9.4 Conductor 测试矩阵

1. 需求明确，直接 plan_tasks。
2. 需求不明确，先 ask_user。
3. 非法 Agent ID 被确定性校正或拒绝。
4. 循环依赖被拒绝。
5. 合法 DAG 按 wave 执行。
6. 同 wave 并发受全局信号量限制。
7. 上游失败导致下游 skipped。
8. required input 缺失导致任务不启动。
9. 子 Agent 未 report_task_result。
10. acceptance criteria 缺失或失败。
11. required file/command evidence 缺失。
12. 同 wave 文件冲突。
13. Recovery Plan 成功。
14. Recovery Plan 失败。
15. 父 Run abort 级联子 Run。
16. Plan revise 后重新审批。

## 9.5 重启恢复测试

需要建立独立临时数据库，模拟：

1. running Run。
2. running child Run。
3. running task attempt。
4. pending write/bash/question/plan。
5. running compaction job。
6. 已完成 task + output binding。
7. 一半失败的 Conductor Plan。

执行启动恢复后断言：

- 状态全部可解释。
- 旧审批无法继续产生副作用。
- 恢复 API 能创建新 Run。
- 成功结果被复用。
- 恢复链可以查询。

## 9.6 数据库升级测试

至少覆盖：

- 全新空数据库。
- 只有基础业务表的旧数据库。
- 已有 `agent_runs` 但缺少新增列。
- 已有旧 `conductor_task_results`。
- 已有 pending approvals。
- 已有 context summary 和 compaction job。
- bootstrap 连续执行两次。

## 9.7 Workspace 安全回归

- `..`。
- 绝对路径。
- Windows 盘符路径。
- 混合 `/` 和 `\`。
- symlink。
- Windows junction。
- 大文件。
- 二进制文件。
- 文件读取期间删除。
- 危险 Bash。
- 需要审批但不在黑名单的 Bash。

## 9.8 完成标准

- CI 无需真实 DeepSeek Key 即可验证正式后端路径。
- 主要成功和失败场景都有确定性测试。
- 重启恢复和数据库升级不是只靠人工验证。
- 测试不存在依赖执行顺序或共享全局数据库的偶发失败。

---

# P5：文档、代码质量与发布收口

## 10.1 目标

消除代码和规格漂移，建立当前产品范围的最终完成定义。

## 10.2 文档同步

### `AGENT_BACKEND.md`

需要更新：

- 当前正式支持范围。
- 当前真实测试数量。
- Run 详情和错误分类。
- Conductor Plan/attempt 持久化。
- 重启恢复的准确语义。
- 压缩任务状态机。
- 删除过期行号和已变化的代码片段。

### OpenSpec

重点同步：

- `openspec/specs/conductor/spec.md`
- `openspec/specs/persistence/spec.md`
- `openspec/specs/conversation-context/spec.md`
- `openspec/specs/tools/spec.md`

### 编号 Spec

重点同步：

- `specs/06-conductor-flow.md`
- `specs/08-db-schema.md`
- `specs/13-conversation-context.md`
- `specs/16-task-contract-handoff.md`
- `specs/17-conductor-plan-review.md`

特别注意：

- Spec 08 当前仍描述较少的基础表，需要加入后续已经存在的审批、编排和压缩任务表。
- Spec 17 明确 pending plan resolver 不跨重启持久化。实现恢复 Run 时不要偷偷改变该契约；若要改变必须先更新 Spec。

## 10.3 代码清理

1. 清理后端 ESLint warning。
2. 删除确认无引用的旧 helper。
   - 例如未使用的 demo Plan helper。
   - 删除前必须用 `rg` 确认无外部引用。
3. 清理未使用 import 和变量。
4. 用统一 Logger 替代业务 console。
5. 执行 `git diff --check`。
6. 检查 LF/CRLF，避免无意义全文件变更。

## 10.4 最终质量门槛

必须全部通过：

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
```

Lint 最终目标：

- 业务源码 0 warning。
- 测试源码尽量 0 warning。
- 不通过全局关闭规则掩盖问题。

## 10.5 发布验收

人工最小验收：

1. 空数据库启动。
2. 配置 DeepSeek Key。
3. 单 Agent 普通对话。
4. Agent 读取和写入 Workspace。
5. Review 模式批准写入。
6. 群聊由 Conductor 生成计划。
7. 用户 revise Plan。
8. 子任务产出 Artifact。
9. 制造任务失败并进入 Recovery。
10. 长对话执行压缩。
11. 在运行中重启服务。
12. 查看 interrupted Run 并创建恢复 Run。
13. 通过 runId 查看完整诊断信息。

## 10.6 完成标准

- 文档与实现一致。
- 当前范围没有阻塞发布的类型、Lint、测试和构建问题。
- 新开发者只读 `CLAUDE.md`、`OVERVIEW.md`、`AGENT_BACKEND.md` 和本计划即可理解系统状态。
- 不再把 Claude/Codex、桌面端和移动端计入 DeepSeek Web 后端完成度。

---

## 11. 优先级与依赖关系

| 优先级 | 工作 | 依赖 | 完成后估算 |
|---|---|---|---:|
| P0 | Run 诊断查询正确性 | 无 | 91% |
| P1 | Plan revision 与 task attempt 持久化 | P0 | 93% |
| P2 | 重启恢复与 Recovery Run | P1 | 95% |
| P3 | 错误分类、Logger 与诊断时间线 | P0-P2 | 97% |
| P4 | DeepSeek/恢复/迁移端到端验收 | P0-P3 | 99% |
| P5 | 文档和发布收口 | P0-P4 | 100% |

推荐严格按 P0 -> P1 -> P2 执行。P3 可以在 P1 后半段并行，但最终 Run 诊断结构必须等 P1/P2 的持久化模型稳定后再定稿。

---

## 12. 推荐提交拆分

```text
fix(diagnostics): return all child runs and plan bindings
feat(conductor): persist plan revisions and task attempts
feat(recovery): create recovery runs from interrupted conductor
feat(observability): unify backend errors and structured logging
test(deepseek): cover protocol failures and multi-round tool loops
test(recovery): cover restart recovery and duplicate side effects
test(db): verify idempotent legacy database upgrades
docs(backend): align backend guide and specs with final behavior
chore(quality): clear backend lint and diff-check warnings
```

不要把数据库模型、恢复流程、诊断 API 和文档更新全部塞进一个提交。每个提交应能独立通过对应测试。

---

## 13. 最终验收清单

### Run 与诊断

- [ ] Run API 返回全部状态的子 Run。
- [ ] Run API 返回全部 Plan revision。
- [ ] Run API 返回 task attempts、bindings 和 conflicts。
- [ ] Run API 返回 error category 和 retryable。
- [ ] Run API 不泄漏密钥和敏感内容。

### Conductor

- [ ] 初始、revise 和 Recovery Plan 均持久化。
- [ ] task 重试不会覆盖旧 attempt。
- [ ] output binding 可追溯到真实 Plan/task/attempt。
- [ ] conflict 可追溯到真实 Plan 和 wave。
- [ ] 缺少报告、验收或证据时不会误判完成。

### 重启恢复

- [ ] running Run/attempt 在重启后变为 interrupted。
- [ ] pending approval 在重启后不能继续产生副作用。
- [ ] 用户可以创建新的 Recovery Run。
- [ ] Recovery Run 关联原 Run。
- [ ] 已完成且证据有效的 task 不会无条件重跑。

### 上下文

- [ ] Pinned 超预算不调用模型。
- [ ] 压缩任务并发保护有效。
- [ ] 压缩失败分类和 retryable 正确。
- [ ] 压缩任务重启后进入 interrupted。
- [ ] Summary、Pinned、Recent 和 Current Turn 顺序符合 Spec 13。

### DeepSeek

- [ ] 文本、reasoning、usage 和 Tool Loop 正常。
- [ ] 401、403、429、timeout 和 5xx 分类正确。
- [ ] 无效 JSON、空 choices 和中途断线可诊断。
- [ ] Abort 能停止后续 Tool Loop。

### 安全

- [ ] Workspace 路径、symlink 和 junction 无法逃逸。
- [ ] 危险 Bash 被拒绝。
- [ ] 高风险 Bash 需要审批。
- [ ] 重复审批只有一个请求成功。
- [ ] 日志和诊断接口不泄漏凭据。

### 质量

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `git diff --check`
- [ ] `AGENT_BACKEND.md` 与当前实现一致
- [ ] OpenSpec 与编号 Spec 已同步

---

## 14. 完成定义

当 P0-P5 全部完成后，AgentMeld 在当前限定范围内应达到：

1. DeepSeek Custom Agent 的消息、工具、审批和上下文链路稳定。
2. Conductor 能可靠规划、审批、执行、校验、恢复和聚合。
3. 任务结果有真实证据，重试和 Recovery 不覆盖历史。
4. 服务重启不会留下无法解释的 running 或 pending 状态。
5. interrupted 多 Agent 任务可以通过新 Recovery Run 继续。
6. 任意失败都能通过 runId、错误分类和结构化状态定位。
7. 自动测试覆盖核心成功路径、失败路径、数据库升级和重启恢复。
8. 文档、规格和代码保持一致。

满足以上条件后，当前 Web + DeepSeek 后端可视为 100% 完成。
