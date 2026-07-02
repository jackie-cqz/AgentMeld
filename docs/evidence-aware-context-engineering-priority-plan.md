# AgentMeld Evidence-aware Context Engineering 目标与优先级实施计划

> 文档状态：待实施  
> 编写日期：2026-07-02  
> 当前基线：本地优先 Web 版本，Next.js + TypeScript + SQLite + DeepSeek / OpenAI-compatible Custom Agent  
> 目标能力：证据驱动的任务上下文闭环  
> 实施范围：Conductor DAG、子 Agent 上下文、工具证据、任务验收、失败重试、下游传播、诊断 UI  
> 行号基线：2026-07-02 当前工作区；实施时应优先使用函数名、类型名和注释锚点定位，不能只依赖行号

## 1. 文档目的

本文档用于把 AgentMeld 当前的“DAG 调度 + 子 Agent Prompt + 任务报告 + 部分工具证据校验”升级为完整的 Evidence-aware Context Engineering：

> Conductor 不把群聊历史直接转发给每个 Agent，而是根据当前任务、DAG 依赖、已验证的上游产物、工具执行证据、失败原因、验收标准和 Token 预算，为每次 task attempt 编译一份最小、相关、可验证、可追溯的任务上下文。任务输出只有通过证据校验后，才允许进入下游 Agent 的上下文。

该能力不是一个新的 Prompt 模板，而是一条贯穿以下层次的系统能力：

1. Plan schema：任务必须声明依赖、输入、输出和验收契约。
2. Runtime identity：每一次任务尝试必须有稳定的 plan/task/attempt/context 身份。
3. Fact registry：Conductor 提取候选关键信息，Runtime 规范化 canonical key 并维护 active/superseded 版本。
4. Evidence ledger：工具执行产生不可变、可追溯的证据记录。
5. Context compiler：系统按策略选择 active Fact 和任务上下文并生成 manifest。
6. Verification gate：代码根据验收标准关联真实证据，不信任 Agent 自述。
7. Propagation gate：只有 verified 输出可绑定到 DAG 并向下游传播。
8. Retry context：失败任务收到结构化失败增量，而不是重复整段聊天。
9. Observability：用户和开发者能查看“给了 Agent 什么、为什么给、依据是什么”。

完成该计划后，AgentMeld 可以形成以下闭环：

```text
用户需求
  -> Conductor 提取候选 Fact
  -> Runtime 规范化并更新会话 Active Facts
  -> Conductor 生成任务 DAG 和 Evidence Contract
  -> Context Compiler 为 task attempt 编译上下文快照
  -> 子 Agent 执行工具
  -> Tool Runtime 自动记录 Evidence Ledger
  -> Verification Engine 对照 Acceptance Criteria 验证
  -> verified_complete
       -> 输出绑定到 DAG
       -> 进入下游任务上下文
     verification_failed
       -> 生成 FailureContext
       -> 下一次 attempt 只接收修复所需增量
```

---

## 2. 当前实现基线

## 2.1 已存在、可以直接复用的能力

### 2.1.1 Plan 已包含任务契约的初始字段

当前 `src/server/tools/orchestrator-tools.ts` 和尚未接入活动链路的 `src/server/tools/conductor-tools.ts` 已包含：

- `dependsOn`
- `inputs`
- `expectedOutputs`
- `acceptanceCriteria`
- `targetPaths`
- `requiredCommands`
- `requiredEvidence`
- `maxAttempts`

当前关键位置：

- `src/server/tools/orchestrator-tools.ts`：`ParsedTask`、`parsePlanArgs()`、`validatePlan()`。
- `src/server/tools/conductor-tools.ts:64-94`：Plan tool JSON schema。
- `src/server/tools/conductor-tools.ts:246-263`：Zod 参数 schema。
- `src/server/tools/conductor-tools.ts:320-333`：`ParsedTask` 类型。
- `src/server/tools/conductor-tools.ts:424-434`：默认值归一化。
- `src/shared/types.ts:325-339`：前后端共享 `DispatchPlanItem`。

这些字段可以作为 Evidence Contract 的输入，但目前大多仍是自由文本，缺少可执行 validator。

### 2.1.2 DAG 和 output binding 已存在

当前能力：

- `src/server/dispatch-plan.ts:66` 的 `compileAndValidateDispatchPlan()` 负责编译和校验 Plan。
- `src/server/orchestrator-service.ts` 使用 `topologicalWaves()` 按 DAG 波次执行。
- `src/server/child-prompt-builder.ts:35` 的 `resolveTaskInputs()` 根据 `taskId.outputKey` 解析上游 Artifact。
- `src/server/repositories.ts:493` 的 `persistOutputBinding()` 将输出绑定写入 SQLite。

这意味着当前系统已经有“执行图”，本计划主要把它升级为“执行图 + 上下文路由图 + 证据传播图”。

### 2.1.3 子 Agent 已有隔离 Prompt

`src/server/child-prompt-builder.ts:68` 的 `buildChildTaskPrompt()` 已输出：

- `<recent_conversation>`
- `<required_inputs>`
- `<expected_outputs>`
- `<upstream_artifacts>`
- `<acceptance_criteria>`
- `<task_evidence_contract>`
- `<your_task>`

同时 `src/server/agent-runner.ts:211-269` 已规定 child run 跳过普通 conversation history，避免把完整群聊重复注入。

该方向是正确的，但当前 child context 仍然只是 Prompt 拼接，没有独立数据模型、版本、快照、来源 manifest 和预算裁剪。

### 2.1.4 已有部分真实工具证据

当前工具证据入口：

- `src/server/dispatch-tool-evidence.ts:1-18`：文件和命令证据类型。
- `src/server/dispatch-tool-evidence.ts:20-28`：全局内存 Map。
- `src/server/tools/fs-write.ts:97-105`、`:137-145`：记录文件写入证据。
- `src/server/tools/bash.ts:142-150`：记录命令执行证据。
- `src/server/task-result-report.ts:19-139`：任务结果代码校验。

这证明系统已经开始遵循 “Evidence > declaration”，但证据目前不完整、不持久、缺少统一身份和可信级别。

### 2.1.5 已有任务结果、Plan、Binding 和冲突持久化

当前 SQLite 表：

- `orchestration_task_results`
- `orchestration_plans`
- `orchestration_output_bindings`
- `orchestration_conflicts`

定义位置：

- `src/db/bootstrap.ts:114-128`
- `src/db/bootstrap.ts:144-176`
- `src/server/repositories.ts:321-350`
- `src/server/repositories.ts:470-537`

这些表可以继续保留，但 task attempt、context snapshot、evidence、criterion verdict 需要新增独立持久化。

---

## 2.2 当前关键差距

### 2.2.1 活动运行链路仍使用 Orchestrator 命名

当前：

- `src/server/agent-runner.ts:20` 导入 `executeOrchestrator`。
- `src/server/agent-runner.ts` 实际调用 `src/server/orchestrator-service.ts`。
- `src/server/tools/registry.ts:59` 仍导入 `orchestrator-tools.ts`。
- `src/server/child-prompt-builder.ts:1`、`src/server/task-result-report.ts:2` 仍依赖 `orchestrator-tools.ts`。
- 工作区同时存在 `conductor-service.ts` / `conductor-tools.ts` 和旧文件。

后续不能同时修改两套实现，否则 Evidence Context 会发生逻辑分叉。实施前必须确定唯一活动链路。

### 2.2.2 task attempt 没有完整身份

`startAgentRun()` 当前只接收：

- `conversationId`
- `agentId`
- `triggerMessage`
- `runId`
- `parentRunId`

位置：`src/server/agent-runner.ts:57-63`。

child run 没有直接携带：

- `planId`
- `taskId`
- `attempt`
- `contextSnapshotId`

工具层只能通过 `runId` 和 `parentRunId` 判断是否为子任务，无法稳定地把证据关联到某个 Plan revision 和 task attempt。

### 2.2.3 工具证据只存在内存

`src/server/dispatch-tool-evidence.ts:20-28` 使用 `globalThis` Map：

- 服务重启后证据丢失。
- Run 结束后立即清理，无法审计。
- 无法用于页面刷新恢复。
- 无法重建失败上下文。
- 无法证明某个 Artifact 或文件来自哪个 task attempt。

### 2.2.4 证据种类不完整

当前只有：

- `fileWrites`
- `commands`

缺少：

- Artifact 创建和版本。
- Deployment 创建和可访问状态。
- 文件读取来源。
- Artifact 读取来源。
- 用户回答和用户确认。
- 审批通过或拒绝。
- 测试结果的结构化摘要。
- Tool call 的失败与修复关系。
- Workspace 文件 hash 和产物 content hash。

### 2.2.5 验收仍部分信任自我报告

`src/server/task-result-report.ts` 中：

- `targetPaths` 同时接受真实 file write 和 Agent 报告的文件。
- `requiredCommands` 同时接受真实 command evidence 和 Agent 报告的 command/test。
- `requiredEvidence` 使用文本 `includes()` 判断。

这会导致 Agent 在 `report_task_result` 中声明“已执行测试”时，即使系统没有真实工具事件，也可能通过部分验收。

### 2.2.6 output binding 没有 verification gate

`src/server/orchestrator-service.ts:530-543` 在最终 evaluation 之后遍历 `report.artifacts`，但没有先判断 `evaluation.status === "complete"`。

因此失败任务只要报告了一个同会话 Artifact，仍可能进入 `outputBindings`，并被后续任务当成合法输入。这是 Evidence-aware 闭环必须优先修复的问题。

### 2.2.7 子任务上下文包含无关 Artifact

`src/server/orchestrator-service.ts:441-457`：

1. 先加入 `resolvedInputs` 对应 Artifact。
2. 随后又遍历整个 `outputBindings`，把所有已绑定 Artifact 加入 `upstreamArtifacts`。

这会让没有依赖关系的旁支任务产物进入当前 Agent 上下文，削弱 DAG 的上下文隔离。

### 2.2.8 Context 没有快照和 manifest

当前 `buildChildTaskPrompt()` 返回一个字符串，系统不知道：

- 具体注入了哪些来源。
- 哪些条目因预算被裁剪。
- 哪些信息是 verified，哪些只是 reported。
- 某次失败重试使用的是哪一版上下文。
- 同一 task 的两个 attempt 为什么得到不同上下文。

### 2.2.9 重试只追加一条错误文本

`src/server/orchestrator-service.ts:485-488` 使用：

```text
原 Prompt + attempt + previous error string
```

这不能表达：

- 哪条验收标准失败。
- 哪些证据有效、哪些失效。
- 哪个文件已经改过。
- 哪条命令失败及 exit code。
- 哪些输出已经完成，不应重复生成。

### 2.2.10 前端只显示任务状态，不显示证据闭环

`src/components/dispatch-progress.tsx:54-105` 当前显示：

- Agent
- Task 状态
- dependsOn
- acceptanceCriteria
- expectedOutputs
- targetPaths
- error

但没有显示：

- context snapshot。
- evidence count。
- criterion verdict。
- reported / checking / verified 状态。
- 输出为什么可以或不可以传给下游。

---

## 3. 目标原则与强制不变量

## 3.1 Context 是编译产物，不是聊天切片

每个 task attempt 必须先生成 `TaskContextEnvelope`，再渲染成模型 Prompt。

禁止直接在 `runChildTask()` 中继续追加零散 Prompt 字符串作为长期方案。

## 3.2 SQLite 是可恢复状态的唯一来源

必须持久化：

- task attempt 身份。
- context snapshot。
- context manifest。
- evidence record。
- criterion verdict。
- failure context。
- verification status。

只允许在内存保存：

- 当前进程的 `AbortController`。
- 正在执行的工具临时结果。
- 编译过程中尚未提交的候选上下文。

## 3.3 DAG 同时是执行图和上下文路由图

默认传播规则：

- 只传播直接依赖节点声明的 output。
- 只传播 `verified_complete` 节点的 output。
- 不传播旁支节点输出。
- 不传播其他 Agent 的 thinking/tool log。
- 未验证输出只能进入诊断上下文，不得作为事实进入执行上下文。

## 3.4 Evidence 优先级高于 Agent 声明

可信级别：

```text
L0 authoritative：用户明确确认、系统配置、审批结果
L1 verified：工具执行结果、数据库存在性、文件 hash、命令 exit code
L2 accepted：已通过 criterion verification 的 task output
L3 reported：Agent 的 report_task_result 自述
L4 retrieved：从历史聊天或搜索召回的相关文本
```

冲突时高等级覆盖低等级。

## 3.5 每个验收结论必须能指向证据

任何 `passed` criterion 必须至少满足以下之一：

- 关联一个或多个 `evidenceId`。
- criterion 明确属于人工语义审查，并关联 reviewer verdict。
- criterion 明确属于用户确认，并关联 `user_confirmation` evidence。

不允许只有 `"passed": true` 而没有依据。

## 3.6 Evidence-aware 不等于把所有日志放进 Prompt

完整证据保存在 Ledger。

Prompt 中只注入：

- 证据摘要。
- 状态。
- 必要字段。
- `evidenceId`。

Agent 需要全文时再通过工具读取。

## 3.7 每次重试必须创建新 Context Snapshot

同一 task 的每个 attempt：

- 使用新的 `attemptId`。
- 使用新的 `contextSnapshotId`。
- 保留上一 attempt 的证据。
- 将失败证据标为 diagnostic，不覆盖历史。
- 不复用不可审计的内存 Prompt。

## 3.8 Evidence-aware Compact Context 总体方案

AgentMeld 最终不应在以下两种方案中二选一：

```text
A. 只做与当前任务相关且经过证据验证的上下文。
B. 只做删除噪声、摘要历史和 Token 裁剪的精简上下文。
```

目标方案应组合为：

> **Evidence-aware Compact Context：先通过 Fact、DAG、Evidence 和状态门禁判断哪些信息有资格进入当前任务，再通过相关性排序、结构化摘要、细节外置和 Token 预算决定这些合格信息以什么粒度进入模型。**

完整处理链路：

```text
原始消息 / Workspace / Artifact / Tool Result / Task Result
        ↓
第一阶段：资格过滤（Hard Filter）
        ↓
第二阶段：相关性选择（Relevance Selection）
        ↓
第三阶段：内容压缩与细节外置（Compression / Externalization）
        ↓
第四阶段：Token 预算编排（Budget Packing）
        ↓
Task Context Envelope + Context Manifest
        ↓
LLM
```

### 3.8.1 第一阶段：资格过滤

Hard Filter 只回答：

```text
“这条信息是否有资格进入当前任务的候选上下文？”
```

判断条件：

1. 是否属于当前 conversation。
2. 是否与当前 task 或 task namespace 相关。
3. 是否来自当前 task 的直接 DAG 依赖。
4. Fact 是否为 `active`。
5. 上游 task 是否为 `verified_complete`。
6. Artifact 是否具有 verified output binding。
7. Evidence 是否为 `valid` / `accepted`。
8. 信息是否已被 superseded、stale、rejected。
9. 当前 Agent 是否有权读取该作用域。

直接排除：

- superseded Fact。
- pending/rejected Fact。
- failed task 产生但未通过验收的输出。
- 无 DAG 依赖的旁支 Artifact。
- 其他 Agent 的 thinking 和完整工具过程。
- 已被新 Evidence 取代的旧文件 hash、旧部署和旧结论。

Hard Filter 是确定性规则，不能完全交给 LLM 判断。

### 3.8.2 第二阶段：相关性选择

通过 Hard Filter 只说明信息可信且允许使用，不代表所有信息都应进入 Prompt。

Context Compiler 对合格候选继续判断：

- 是否直接支持当前 task objective。
- 是否是 required Fact。
- 是否属于 targetPaths。
- 是否对应本次 Acceptance Criterion。
- 是否解释当前 FailureContext。
- 是否是 Agent 下一步操作所需。
- 是否只需要保留引用，而不需要内容。

优先级建议：

```text
P0 Mandatory：
- 当前 task objective。
- active 用户硬约束。
- task.requiredFactKeys。
- Acceptance Criteria。
- required verified inputs。
- 当前 FailureContext。

P1 High：
- targetPaths 当前状态。
- 与 criterion 直接相关的 Evidence 摘要。
- active 设计/技术决策。
- 上游 verified task summary。

P2 Optional：
- 相关近期对话。
- 检索出的历史片段。
- 非 required upstream input。
- 辅助代码片段。

P3 Reference-only：
- Artifact 全文。
- 完整文件。
- 完整命令日志。
- 完整测试报告。
```

### 3.8.3 第三阶段：压缩和细节外置

精简不能破坏事实状态和证据来源。

压缩规则：

1. 重复表达合并成一个 canonical Fact。
2. 完成的历史分支只保留结论、输出 ID 和验证状态。
3. 长 Artifact 只保留 title、id、version、verified 摘要。
4. 长文件只保留 path、hash、相关符号或相关片段。
5. 命令日志只保留 command、exitCode、错误摘要和 evidenceId。
6. 测试报告只保留通过数、失败数、主要错误和 evidenceId。
7. 无意义寒暄、重复确认和低价值过程直接丢弃。
8. 完整细节保存在 SQLite、Workspace 或 Artifact Store，按需重读。

示例：

```text
禁止：
把 10,000 字符 pnpm build 日志放入 Prompt。

推荐：
pnpm build failed, exitCode=1
primaryError=src/App.tsx:42 TS2322
evidenceId=ev_build_01
```

Agent 需要完整日志时，通过受控工具读取 `ev_build_01` 对应的清洗后详情。

### 3.8.4 第四阶段：Token 预算编排

Token 裁剪不能简单地从最早消息开始删除。

推荐预算顺序：

```text
固定成本：
system prompt
+ tool schemas
+ output reserve
+ protocol margin

任务上下文：
Mandatory
+ High
+ Optional
+ Reference-only metadata
```

当预算不足时：

```text
1. 删除 Optional 中最低相关内容。
2. 将 Optional 历史改为更短摘要。
3. 缩短 High 中的 Evidence 摘要，但保留 evidenceId。
4. 将非 required Artifact 改为 reference-only。
5. Mandatory 不允许静默裁剪。
```

如果 Mandatory 本身超过窗口：

- 不调用模型。
- 返回 `task_context_overflow`。
- 显示各部分 Token 明细。
- 要求拆分 task、缩短 required input 或调整模型窗口。

### 3.8.5 最终上下文三层结构

模型实际接收的 Task Context 分三层：

```text
第一层：必须执行的事实与契约
- 当前任务目标。
- active 用户约束。
- required Facts。
- verified upstream inputs。
- Acceptance Criteria。

第二层：当前执行和诊断状态
- targetPaths。
- 相关 Workspace 状态。
- FailureContext。
- 关键 Evidence 摘要。
- 下一步行动。

第三层：可选补充
- 相关近期对话。
- 检索历史。
- 辅助代码片段。
- 非 required 参考输入。
```

这三层不是三个独立 Prompt，而是同一 `TaskContextEnvelope` 中不同优先级的 section。

### 3.8.6 Todo List 具体比较

假设当前会话包含：

```text
1. 用户要求使用 React。
2. 用户最初要求蓝色主题。
3. 用户后来要求改成绿色主题。
4. 用户明确不需要登录。
5. PM 生成 verified PRD：art_prd_01。
6. UI 第一次生成 art_style_01，但验收失败。
7. UI 重试生成 verified art_style_02。
8. 数据分析 Agent 生成 art_analysis_01，但 t3 不依赖它。
9. 前端第一次实现后 pnpm build 失败。
10. 大量聊天、文件内容和工具日志。
```

原始上下文假设约 30,000 Token。

当前任务：

```text
t3 Frontend：实现 Todo List
dependsOn=[t1,t2]
attempt=2
```

Hard Filter：

```text
technical.frontend.framework=React
active
-> 保留

ui.theme.primaryColor=blue
superseded
-> 排除

ui.theme.primaryColor=green
active
-> 保留

feature.auth.required=false
active
-> 保留

art_prd_01
来自直接依赖 t1，verified
-> 保留

art_style_01
来自 t2 失败 attempt，rejected
-> 排除

art_style_02
来自 t2 verified attempt
-> 保留

art_analysis_01
来自无依赖旁支
-> 排除
```

资格过滤后，候选上下文可能从约 30,000 Token 降到约 8,000 Token。

随后执行精简：

```text
完整 PRD
-> PRD ID + 任务相关摘要

完整 Style Guide
-> Style Guide ID + 绿色主色/720px/8px 圆角

完整 build 日志
-> exitCode + TS2322 摘要 + evidenceId

完整文件
-> target path + hash + 错误相关片段
```

最终发送给模型的上下文可能约为 2,000 Token：

```xml
<task_context
  context_id="ctx_t3_2"
  task_id="t3"
  attempt="2">

  <objective>
    实现 Todo List React 应用并通过生产构建。
  </objective>

  <active_facts>
    <fact key="technical.frontend.framework"
          source="msg_01"
          trust="authoritative">React</fact>
    <fact key="ui.theme.primaryColor"
          source="msg_25"
          trust="authoritative">green</fact>
    <fact key="feature.auth.required"
          source="msg_01"
          trust="authoritative">false</fact>
  </active_facts>

  <verified_inputs>
    <artifact id="art_prd_01"
              from_task="t1"
              verification="vd_prd">
      创建、完成、删除任务；使用 localStorage；不需要登录。
    </artifact>
    <artifact id="art_style_02"
              from_task="t2"
              verification="vd_style">
      绿色主色；720px 内容宽度；8px 卡片圆角。
    </artifact>
  </verified_inputs>

  <failure_context>
    pnpm build exitCode=1
    src/App.tsx:42 TS2322
    evidenceId=ev_build_01
  </failure_context>

  <evidence_contract>
    <criterion id="source-change">必须修改 src 目录</criterion>
    <criterion id="build">pnpm build 必须 exitCode=0</criterion>
    <criterion id="deployment">必须产生真实部署记录</criterion>
  </evidence_contract>
</task_context>
```

### 3.8.7 三种方案的结果差异

#### 只做精简上下文

优点：

- Token 少。
- 当前任务信息集中。

问题：

- 可能摘要了失败的 `art_style_01`。
- 可能把旧蓝色要求和新绿色要求同时保留。
- 无法保证 Agent 声称的“构建成功”是真的。

#### 只做 Evidence-aware 上下文

优点：

- 输入可信。
- 上游传播安全。
- 失败结果不会污染下游。

问题：

- verified PRD、Style Guide、文件和测试证据仍可能很长。
- Token 成本和注意力稀释仍然存在。

#### Evidence-aware Compact Context

同时获得：

- 正确：只使用 active / verified 信息。
- 相关：只使用当前 task 和 DAG 依赖信息。
- 精简：长内容摘要化或引用化。
- 可恢复：完整细节仍在外部存储。
- 可解释：Manifest 记录纳入和排除原因。
- 可验证：任务结果继续经过 Evidence Contract。

### 3.8.8 与各优先级的对应关系

该总体方案不是额外的平行模块，而由后续优先级共同实现：

```text
P0：建立 task/attempt/context 身份和最小传播门禁。
P1：持久化 Evidence Ledger。
P2：维护 active/superseded Fact Registry。
P3：实现 Hard Filter、相关性选择、预算编排和 Context Snapshot。
P4：根据 Evidence Contract 验证结果。
P5：构建精简的 FailureContext。
P6：只沿 DAG 传播 verified context。
P7：展示 Context Manifest、Evidence 和 Verdict。
P8：增加历史检索、质量指标和进一步压缩评估。
```

## 3.9 Evidence-aware Compact Context 的优先级落地总表

本节明确 P0-P8 对组合方法分别负责什么。后续各优先级的详细文件修改必须满足本节定义的输入和输出，避免只完成表结构或 UI，却没有形成真正的上下文编译闭环。

### P0：建立可追踪身份和最小硬门禁

负责解决：

```text
系统必须先知道“这是哪个 Plan 的哪个 Task 的第几次尝试”，
否则无法判断上下文、证据和输出属于谁。
```

输入：

- Conductor run。
- Plan revision。
- ParsedTask。
- child run。

代码任务：

1. 建立 `TaskExecutionIdentity`。
2. 将 `planId/taskId/attemptId/contextSnapshotId` 贯穿到 ToolContext。
3. 阻止 failed task 写入 output binding。
4. 移除全局广播所有 output binding 的行为。
5. 统一唯一活动 Conductor service。

本阶段 Hard Filter：

- conversationId 不一致直接拒绝。
- task 无依赖关系的 Artifact 不进入候选。
- failed task output 不进入下游。

输出：

```text
每条 child run、tool call、output binding 都有明确任务身份。
```

验收：

- 可以从 tool call 反查 task attempt。
- failed task Artifact 无法成为下游 required input。
- t3 不会看到没有 dependsOn 的 t5 Artifact。

### P1：把完整细节外置到 Evidence Ledger

负责解决：

```text
Prompt 不保存完整工具日志，但系统必须长期保存可验证细节，
并允许 Context Compiler 只注入摘要和 evidenceId。
```

输入：

- ToolContext。
- Tool args/result。
- task identity。

代码任务：

1. 持久化文件、命令、测试、Artifact、部署、审批和用户回答 Evidence。
2. 保存 content hash、output hash、exitCode 和清洗后 excerpt。
3. 对长日志只保存受限 excerpt + hash。
4. 增加 Evidence query repository。
5. 增加受控 `read_evidence` 工具，允许 Agent 按 evidenceId 获取清洗后的详细信息。

建议新增：

```text
src/server/tools/read-evidence.ts
```

Tool 输入：

```typescript
{
  evidenceId: string;
}
```

访问检查：

- evidence 必须属于当前 conversation。
- child Agent 只能读取当前 task、直接依赖 task 或 FailureContext 明确引用的 Evidence。
- 禁止返回 secret 和未清洗原始 stdout。

本阶段 Externalization：

```text
完整细节 -> SQLite / Workspace / Artifact Store
Prompt -> 摘要 + id + hash + 状态
```

输出：

```text
EvidenceRef {
  evidenceId,
  type,
  status,
  summary,
  contentHash
}
```

验收：

- 10,000 字符 build 日志不会直接进入 Prompt。
- Agent 可以通过 `read_evidence(ev_xxx)` 重读允许访问的错误详情。
- 服务重启后 Evidence 仍可查询。

### P2：维护当前有效的结构化事实

负责解决：

```text
同一事实被用户用不同自然语言表达时映射到稳定 canonical key；
用户修改要求时旧 Fact 失效，新 Fact 生效。
```

输入：

- 用户新消息。
- 内置 Fact Definition。
- conversation 动态 Definition。
- 当前 active Facts。

代码任务：

1. Conductor 提取 Candidate Fact。
2. Runtime 进行 definitionId、Alias、entity/property 匹配。
3. 对未知事实创建 conversation Definition proposal。
4. 事务更新 active/superseded。
5. pending/rejected Fact 不进入正常上下文。
6. Context Compiler 可以按 requiredFactKeys/namespaces 查询。

本阶段 Hard Filter：

- 只允许 active Fact 进入候选。
- superseded/pending/rejected Fact 排除。
- 跨 conversation Fact 排除。

输出：

```text
FactRef {
  factId,
  canonicalKey,
  value,
  trustLevel,
  sourceId
}
```

验收：

- 蓝色主题被绿色主题替代后，后续任务只收到绿色。
- `theme_color` 和 `primary_color` 可以映射到同一个 canonical key。
- 不确定匹配不会覆盖现有 active Fact。

### P3：编译精简任务上下文

负责解决：

```text
将已经具备资格的信息进一步筛选、压缩并装入模型窗口。
```

输入：

- TaskExecutionIdentity。
- ParsedTask。
- active Facts。
- verified upstream inputs。
- Evidence refs。
- Workspace state。
- FailureContext。
- 相关历史候选。
- 模型上下文窗口。

代码任务分为五段：

```text
Candidate Collector
-> Qualification Filter
-> Relevance Ranker
-> Context Compressor
-> Token Budget Packer
```

输出：

- `TaskContextEnvelope`。
- `ContextManifestItem[]`。
- immutable Context Snapshot。
- 最终 Prompt。

验收：

- 同一 Snapshot 可以重放出等价 Prompt。
- Manifest 记录每个 item included/omitted 及原因。
- Mandatory 超预算时失败，不静默删除。
- Todo List 示例能排除旧蓝色、失败 Style Guide 和无关分析 Artifact。

### P4：通过证据验证上下文输出

负责解决：

```text
Agent 输出只是 reported result，只有通过 Criterion Validator 才能成为 verified context。
```

输入：

- Agent task report。
- task Evidence Contract。
- 当前 attempt Evidence。

代码任务：

1. 将 Acceptance Criteria 结构化。
2. 逐条运行 file/command/artifact/deployment/user/reviewer validator。
3. 产生 Criterion Verdict。
4. 只有 passed criterion 支持 verified output binding。
5. 删除机器可验证项的 Agent 自述兜底。

输出：

```text
TaskVerificationResult
VerifiedOutputBinding[]
CriterionVerdict[]
```

验收：

- Agent 声称 build 成功但 exitCode=1 时必须失败。
- failed/rejected output 不能进入下游上下文。
- 每个 passed criterion 都有 evidenceIds。

### P5：生成失败感知的精简重试上下文

负责解决：

```text
重试不重复第一次的全部 Prompt 和工具日志，
只加入修复当前失败所需的增量。
```

输入：

- 上一 attempt Snapshot。
- failed verdict。
- diagnostic Evidence。
- 已修改文件。
- 缺失输出。

代码任务：

1. 生成结构化 FailureContext。
2. 提取主要命令错误和 evidenceId。
3. 标记上一 attempt 已完成、无需重复的部分。
4. 创建新的 Context Snapshot。
5. 将旧 Evidence 保留为 diagnostic，不传播为 accepted output。

输出：

```text
原任务必要上下文
+ 失败 criterion
+ 错误摘要
+ 受影响文件
+ 下一步修复要求
```

验收：

- retry Prompt 不包含完整旧日志。
- retry 能准确指出失败 criterion 和主要错误。
- 已验证上游输入不重复全文注入。

### P6：沿 DAG 传播 verified compact context

负责解决：

```text
多 Agent 之间不传播聊天过程，只传播已验证的最小上下文增量。
```

输入：

- verified task result。
- verified output binding。
- TaskContextDelta。
- 下游 task inputs。

代码任务：

1. 将 DAG edge 实现为 Context Channel。
2. 解析直接依赖的 verified input。
3. 生成上游 TaskContextDelta。
4. 缺少 required verified input 时阻塞下游。
5. Aggregate 只消费 verified result。

输出：

```text
VerifiedTaskInput[]
TaskContextDelta[]
```

验收：

- PM/UI/Frontend/Reviewer 各自只看到与当前任务相关内容。
- UI 失败时 Frontend 不启动。
- Frontend 失败 attempt 不会进入 Reviewer。

### P7：让上下文编译过程可观察

负责解决：

```text
用户和开发者能够看到“模型收到了什么、为什么收到、为什么没收到”。
```

输入：

- Context Snapshot。
- Manifest。
- Evidence summary。
- Verdict。

代码任务：

1. SSE 推送 context/evidence/verdict 摘要事件。
2. API 返回完整 Snapshot 和 Manifest。
3. UI 显示 Mandatory/High/Optional 分层。
4. UI 显示 included/omitted reason。
5. UI 显示 Fact 版本和 Evidence 链。

输出：

- Context Manifest UI。
- Evidence Drawer。
- Criterion Verdict List。
- Task Attempt Timeline。

验收：

- 可以解释绿色主题来自哪条用户消息。
- 可以解释蓝色主题因 superseded 被排除。
- 可以解释 art_analysis_01 因无 DAG 依赖被排除。
- 可以查看当前 Prompt 估算 Token 组成。

### P8：增加检索、评估和自适应压缩

负责解决：

```text
在硬门禁正确后，进一步提高召回率、降低 Token 和验证压缩质量。
```

输入：

- 大量历史消息。
- Context Snapshot 数据集。
- 任务结果和 Verdict。

代码任务：

1. SQLite FTS5 检索相关历史。
2. 为 optional candidate 计算相关性。
3. 建立不同来源的压缩策略。
4. 建立上下文评估 fixture。
5. 统计压缩比、关键事实保留率、无关信息剔除率和验证冲突率。
6. 根据任务类型调整 Optional budget。

输出：

- Retrieval candidates。
- Context quality metrics。
- 离线评估报告。
- 可调 context policy version。

验收：

- 检索结果只能进入 Optional 层，不能覆盖 active Fact。
- 压缩前后 mandatory 信息保留率为 100%。
- 可以量化 30k -> 2k 的来源和裁剪过程，而不只展示最终数字。

---

## 4. 目标运行时数据模型

建议新增 `src/shared/evidence-types.ts`。

```typescript
export type EvidenceType =
  | "file_read"
  | "file_written"
  | "command_executed"
  | "test_executed"
  | "artifact_read"
  | "artifact_created"
  | "artifact_version_created"
  | "deployment_created"
  | "deployment_checked"
  | "approval_resolved"
  | "user_answered"
  | "evidence_read"
  | "task_reported";

export type EvidenceStatus =
  | "valid"
  | "invalid"
  | "stale"
  | "diagnostic";

export type EvidenceTrustLevel =
  | "authoritative"
  | "verified"
  | "accepted"
  | "reported"
  | "retrieved";

export interface EvidenceRecord {
  id: string;
  conversationId: string;
  conductorRunId: string;
  planId: string;
  taskId: string;
  attemptId: string;
  childRunId: string;
  contextSnapshotId: string;
  agentId: string;
  type: EvidenceType;
  status: EvidenceStatus;
  trustLevel: EvidenceTrustLevel;
  sourceKind: "tool_call" | "user" | "system" | "reviewer";
  sourceId: string;
  subjectType: "file" | "command" | "artifact" | "deployment" | "approval" | "answer" | "task";
  subjectId: string;
  payload: Record<string, unknown>;
  contentHash: string | null;
  createdAt: number;
  invalidatedAt: number | null;
}
```

建议新增 `src/shared/task-context-types.ts`。

```typescript
export interface TaskExecutionIdentity {
  conductorRunId: string;
  planId: string;
  planRevision: number;
  taskId: string;
  attemptId: string;
  attempt: number;
  contextSnapshotId: string;
}

export interface ContextFact {
  factId: string;
  definitionId: string;
  canonicalKey: string;
  kind: "goal" | "constraint" | "decision" | "user_answer" | "workspace_state";
  value: unknown;
  valueType: "string" | "number" | "boolean" | "color" | "string_array" | "json";
  sourceType: "message" | "summary" | "evidence" | "plan";
  sourceId: string;
  trustLevel: EvidenceTrustLevel;
  status: "active" | "superseded" | "pending" | "rejected";
  supersedesFactId: string | null;
  updatedAt: number;
}

export interface VerifiedTaskInput {
  fromTaskId: string;
  outputKey: string;
  artifactId: string;
  artifactVersion: number;
  artifactType: string;
  title: string;
  verificationId: string;
  evidenceIds: string[];
}

export interface EvidenceRequirement {
  id: string;
  description: string;
  required: boolean;
  validator: CriterionValidator;
}

export type CriterionValidator =
  | { type: "file_exists"; path: string }
  | { type: "file_changed"; path: string }
  | { type: "command_exit"; command: string; expectedExitCode: number }
  | { type: "artifact_exists"; outputKey: string; artifactType?: string }
  | { type: "deployment_created"; outputKey?: string }
  | { type: "user_confirmation" }
  | { type: "reviewer_verdict"; reviewerAgentId?: string };

export interface FailureContext {
  previousAttemptId: string;
  previousChildRunId: string;
  failedCriteria: CriterionVerdict[];
  failedEvidenceIds: string[];
  failedCommands: Array<{
    command: string;
    exitCode: number | null;
    errorExcerpt: string;
    evidenceId: string;
  }>;
  missingOutputs: string[];
  changedFiles: Array<{
    path: string;
    contentHash: string | null;
    evidenceId: string;
  }>;
  retryInstructions: string[];
}

export interface ContextManifestItem {
  id: string;
  category:
    | "task"
    | "constraint"
    | "upstream_input"
    | "workspace"
    | "evidence_contract"
    | "failure"
    | "retrieved_history";
  sourceType: string;
  sourceId: string;
  reason: string;
  required: boolean;
  trustLevel: EvidenceTrustLevel;
  tokenEstimate: number;
  included: boolean;
  omittedReason: "budget" | "stale" | "unverified" | "unrelated" | null;
}

export interface TaskContextEnvelope {
  schemaVersion: 1;
  policyVersion: string;
  identity: TaskExecutionIdentity;
  task: {
    title: string;
    objective: string;
    assignedAgentId: string;
    dependsOn: string[];
  };
  requirements: {
    constraints: ContextFact[];
    acceptanceCriteria: EvidenceRequirement[];
    expectedOutputs: Array<{
      outputKey: string;
      type: string;
      required: boolean;
      description?: string;
    }>;
  };
  facts: ContextFact[];
  upstreamInputs: VerifiedTaskInput[];
  workspaceState: Array<{
    path: string;
    reason: string;
    contentHash?: string;
  }>;
  failureContext: FailureContext | null;
  retrievedContext: ContextFact[];
  manifest: ContextManifestItem[];
  budget: {
    maxInputTokens: number;
    requiredTokens: number;
    optionalTokens: number;
    omittedTokens: number;
  };
  createdAt: number;
}
```

建议 `CriterionVerdict` 定义为：

```typescript
export interface CriterionVerdict {
  id: string;
  criterionId: string;
  status: "passed" | "failed" | "missing" | "needs_review";
  validatorType: CriterionValidator["type"];
  evidenceIds: string[];
  reason: string;
  checkedAt: number;
}
```

---

## 5. 目标 SQLite 模型

## 5.1 `task_attempts`

每次 task retry 必须新增一行，不能覆盖上一 attempt。

```sql
CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  conductor_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL DEFAULT 0,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  child_run_id TEXT,
  attempt INTEGER NOT NULL,
  context_snapshot_id TEXT,
  execution_status TEXT NOT NULL DEFAULT 'queued',
  verification_status TEXT NOT NULL DEFAULT 'not_started',
  failure_context_json TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(conductor_run_id, plan_id, task_id, attempt)
);
```

状态建议分开：

```text
execution_status:
queued | running | reported_complete | failed | blocked | aborted

verification_status:
not_started | checking | verified | rejected | needs_review
```

避免继续用单个 `complete` 同时表示“Agent 声称完成”和“系统已验证完成”。

## 5.2 `task_context_snapshots`

```sql
CREATE TABLE IF NOT EXISTS task_context_snapshots (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  conductor_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
  policy_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  required_token_estimate INTEGER NOT NULL,
  omitted_token_estimate INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

Snapshot 是不可变记录。重试时创建新 Snapshot，不更新旧行。

## 5.3 `task_evidence`

```sql
CREATE TABLE IF NOT EXISTS task_evidence (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  conductor_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
  child_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  context_snapshot_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  trust_level TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT,
  invalidated_at INTEGER,
  created_at INTEGER NOT NULL
);
```

索引：

```sql
CREATE INDEX IF NOT EXISTS idx_task_evidence_attempt
ON task_evidence(attempt_id, created_at);

CREATE INDEX IF NOT EXISTS idx_task_evidence_subject
ON task_evidence(subject_type, subject_id, status);

CREATE INDEX IF NOT EXISTS idx_task_evidence_task
ON task_evidence(conductor_run_id, plan_id, task_id);
```

## 5.4 `criterion_verdicts`

```sql
CREATE TABLE IF NOT EXISTS criterion_verdicts (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL,
  validator_type TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  UNIQUE(attempt_id, criterion_id)
);
```

## 5.5 与现有表的关系

保留：

- `orchestration_plans`：Plan revision。
- `orchestration_task_results`：面向兼容和聚合的任务最终结果。
- `orchestration_output_bindings`：只保存 verified output。
- `agent_runs`：父子 Run 生命周期。

新增表承担：

- `task_attempts`：每次尝试。
- `task_context_snapshots`：每次尝试收到什么。
- `task_evidence`：每次尝试实际做了什么。
- `criterion_verdicts`：为什么通过或失败。

---

# P0：统一活动链路、任务身份和最小传播门禁

## 6.1 目标

在引入 Evidence Ledger 前，先解决三件事：

1. 只保留一套活动 Conductor 实现。
2. 让 plan/task/attempt/context 身份贯穿 AgentRunner、Adapter 和 ToolContext。
3. 立即阻止 failed task Artifact 进入 output binding。

这是后续所有阶段的前置条件。

## 6.2 修改文件与代码位置

### 6.2.1 `src/server/agent-runner.ts`

当前位置：

- `:20` 导入 `executeOrchestrator`。
- `:57-63` 定义 `StartRunInput`。
- `:186-188` 为 child run 注入 `report_task_result`。
- `:211-269` child run 跳过普通历史。
- `:271-286` 构建 `AdapterInput`。

修改：

1. 将活动入口统一为 `executeConductor`。
2. 扩展 `StartRunInput`：

```typescript
interface StartRunInput {
  conversationId: string;
  agentId: string;
  triggerMessage: Message;
  runId?: string;
  parentRunId?: string | null;
  taskExecution?: TaskExecutionIdentity | null;
}
```

3. 将 `taskExecution` 传入 `AdapterInput`。
4. child run 的判断逐步从 `Boolean(parentRunId)` 改成 `Boolean(taskExecution)`。
5. 保留 `parentRunId` 用于 Run 树，但不能再把它当成 task identity。

### 6.2.2 `src/server/adapters/types.ts`

当前 `AdapterInput` 位于 `:4-17`。

新增：

```typescript
taskExecution?: TaskExecutionIdentity | null;
contextSnapshot?: TaskContextEnvelope | null;
```

`contextSnapshot` 只用于 Custom Agent Prompt 和工具 provenance，不允许 Adapter 修改。

### 6.2.3 `src/server/tools/types.ts`

当前 `ToolContext` 位于 `:1-8`。

修改：

```typescript
export interface ToolContext {
  conversationId: string;
  workspacePath: string;
  agentId: string;
  runId: string;
  parentRunId?: string | null;
  taskExecution?: TaskExecutionIdentity | null;
  abortSignal: AbortSignal;
}
```

### 6.2.4 `src/server/adapters/custom-agent-adapter.ts`

当前 `ToolContext` 构造位于 `:218-227`。

新增：

```typescript
taskExecution: input.taskExecution ?? null
```

以后 Evidence Collector 从 `ctx.taskExecution` 获取 plan/task/attempt/context 身份，不做额外 DB 猜测。

### 6.2.5 `src/server/orchestrator-service.ts` 或统一后的 `src/server/conductor-service.ts`

当前 child run 启动位于 `:509`。

修改顺序：

1. 在每个 attempt 开始前创建 `attemptId`。
2. 编译并保存 `contextSnapshot`。
3. 将以下对象传给 `startAgentRun()`：

```typescript
taskExecution: {
  conductorRunId: parentRunId,
  planId,
  planRevision,
  taskId: task.id,
  attemptId,
  attempt,
  contextSnapshotId
}
```

P0 阶段 Context Compiler 尚未完成时，可以先保存一个最小 Snapshot，只包含现有 child prompt 数据，保证身份链路先贯通。

### 6.2.6 统一 Conductor 文件

当前运行时仍依赖：

- `orchestrator-service.ts`
- `orchestrator-tools.ts`

同时工作区已有：

- `conductor-service.ts`
- `conductor-tools.ts`

实施方法：

1. 对比两套文件，确认新文件包含旧文件全部修复。
2. `agent-runner.ts` 改为导入 `executeConductor`。
3. `tools/registry.ts` 改为导入 `conductor-tools.ts`。
4. `child-prompt-builder.ts`、`task-result-report.ts` 改为导入 `ParsedTask` from `conductor-tools.ts`。
5. 测试全部切到 conductor 文件。
6. 确认无 import 后删除旧运行时文件。
7. SQLite 旧列名 `orchestrator_run_id` 可暂时保留，避免无收益迁移；TypeScript 层统一映射为 `conductorRunId`。

不要在两套 service 中重复实现 Evidence Context。

## 6.3 立即修复 output binding 门禁

当前问题位置：

- `src/server/orchestrator-service.ts:530-543`

修改为：

```typescript
if (evaluation.status === "complete" && report?.artifacts) {
  // validate and persist bindings
}
```

同时增加：

1. `outputKey` 必须存在于 `task.expectedOutputs`。
2. Artifact type 必须匹配 expected output type。
3. Artifact 必须属于当前 conversation。
4. Artifact 必须有当前 attempt 的 `artifact_created` evidence。
5. required output 缺失时，evaluation 必须失败。

P0 尚未有持久 Evidence 时，第 4 项可以先使用当前 child run 中捕获的 tool result 验证；P1 后切到 Ledger。

## 6.4 移除无关 Artifact 传播

当前问题位置：

- `src/server/orchestrator-service.ts:450-457`

删除“遍历所有 `outputBindings` 并加入 upstreamArtifacts”的循环。

`upstreamArtifacts` 只能来自：

```typescript
resolvedInputs
  .filter(input => !input.missing && input.artifactId)
```

如果某个 Artifact 必须跨非直接依赖传播，应由 Plan 显式增加 `inputs` 或依赖边，不能依靠全局广播。

## 6.5 新增 ID

修改 `src/shared/ids.ts:37` 后：

```typescript
export function newTaskAttemptId() { ... }       // ta_
export function newContextSnapshotId() { ... }   // ctx_
export function newEvidenceId() { ... }          // ev_
export function newVerdictId() { ... }           // vd_
```

## 6.6 P0 测试

修改或新增：

- `src/server/agent-runner.test.ts`
- `src/server/adapters/custom-agent-adapter.test.ts`，若不存在则新增。
- `src/server/orchestrator-service.test.ts` 或统一后的 `conductor-service.test.ts`。
- `src/server/tools/registry.test.ts` 或 `tools.test.ts`。

必须覆盖：

1. child run 的 `taskExecution` 能到达 ToolContext。
2. 同一 task 两次 retry 使用不同 attemptId。
3. failed evaluation 不写 output binding。
4. Artifact outputKey 不在 expectedOutputs 时拒绝。
5. Artifact type 不匹配时拒绝。
6. child task 不再收到无依赖旁支 Artifact。
7. 活动源码中不再 import `orchestrator-service` / `orchestrator-tools`。

## 6.7 P0 验收标准

- 任一 tool call 可以确定其 conductorRunId、planId、taskId、attemptId。
- failed task 的 Artifact 永远不能被下游解析为 required input。
- 子 Agent 上下文只包含 DAG 显式依赖的 Artifact。
- 运行时只有一套 Conductor service/tool 实现。

---

# P1：持久化 Evidence Ledger 和 Task Attempt

## 7.1 目标

将当前内存工具证据升级为不可变、可查询、可恢复的 SQLite Evidence Ledger。

## 7.2 数据库修改

### 7.2.1 `src/db/schema.ts`

当前核心表结束位置：

- `agentRuns`：`:127-147`
- `conversationContextSummaries`：`:150-167`

新增 Drizzle schema：

- `taskAttempts`
- `taskContextSnapshots`
- `taskEvidence`
- `criterionVerdicts`

类型分别引用：

- `TaskExecutionIdentity`
- `EvidenceType`
- `EvidenceStatus`
- `EvidenceTrustLevel`
- `CriterionVerdict`

### 7.2.2 `src/db/bootstrap.ts`

当前：

- `agent_runs`：`:95-112`
- `orchestration_task_results`：`:114-128`
- indexes：`:325-350`

修改：

1. 在 orchestration 表附近新增四张表。
2. 增加上述索引。
3. 对已有数据库使用 `CREATE TABLE IF NOT EXISTS`。
4. 若给旧表增加列，使用现有 `ensureColumn()` 模式。
5. 不删除或重命名旧列。

建议给 `orchestration_task_results` 增加：

```sql
verification_status TEXT NOT NULL DEFAULT 'not_started'
verified_attempt_id TEXT
```

最终结果表保存 task 的最终汇总，attempt 细节由 `task_attempts` 保存。

### 7.2.3 `src/db/bootstrap.test.ts`

新增断言：

- 新数据库包含四张新表。
- 旧数据库 bootstrap 后自动补齐。
- attempt 唯一索引有效。
- evidence 删除策略跟随 attempt/run cascade。
- context snapshot 不允许缺少 attempt。

## 7.3 Repository 修改

在 `src/server/repositories.ts:321` 附近新增或拆分到新文件：

推荐新建：

```text
src/server/repositories/task-attempt-repository.ts
src/server/repositories/evidence-repository.ts
src/server/repositories/context-snapshot-repository.ts
src/server/repositories/verdict-repository.ts
```

如果项目暂时坚持单 repository 文件，也必须提供这些函数：

```typescript
createTaskAttempt()
startTaskAttempt()
finishTaskAttempt()
updateTaskAttemptVerification()
getTaskAttempt()
listTaskAttempts()

insertEvidence()
getEvidence()
listEvidenceForAttempt()
listEvidenceForTask()
invalidateEvidence()

insertContextSnapshot()
getContextSnapshot()
listContextSnapshotsForTask()

upsertCriterionVerdict()
listCriterionVerdicts()
```

持久化约束：

- Evidence 只 insert，不 update payload。
- 状态失效通过 `status` / `invalidated_at` 更新。
- Context Snapshot 只 insert，不 update。
- retry 不删除旧 Evidence。

## 7.4 替换 `dispatch-tool-evidence.ts`

当前文件 `src/server/dispatch-tool-evidence.ts:20-74` 是内存存储。

目标：

1. 保留 `recordFileWriteEvidence()` / `recordCommandEvidence()` 作为短期兼容 facade。
2. 内部改为调用 `evidenceRepository.insertEvidence()`。
3. `getRunToolEvidence()` 改为从 SQLite 按 `child_run_id` 查询。
4. `clearRunToolEvidence()` 不再删除 Ledger；改成 no-op 或删除调用。
5. 测试 helper 单独清理测试数据库，不通过生产函数删除审计证据。

## 7.5 新增 Evidence Collector

新建：

```text
src/server/evidence/evidence-collector.ts
src/server/evidence/evidence-extractors.ts
src/server/evidence/evidence-sanitizer.ts
src/server/evidence/evidence-hash.ts
```

职责：

### `evidence-collector.ts`

- 接收 ToolContext、toolName、callId、args、result、duration。
- 确认是否存在 `taskExecution`。
- 调用对应 extractor。
- 持久化一个或多个 EvidenceRecord。
- Evidence 写入失败时记录结构化错误，但不能伪装任务已验证。

### `evidence-extractors.ts`

按工具映射：

```typescript
const extractors: Record<string, EvidenceExtractor> = {
  fs_read: extractFileRead,
  fs_write: extractFileWrite,
  bash: extractCommand,
  read_artifact: extractArtifactRead,
  write_artifact: extractArtifactCreated,
  deploy_artifact: extractDeployment,
  deploy_workspace: extractDeployment,
  ask_user: extractUserAnswer,
  report_task_result: extractTaskReport
};
```

### `evidence-sanitizer.ts`

禁止写入：

- API Key。
- Authorization header。
- 完整附件二进制。
- 超长 stdout/stderr。
- 用户敏感路径之外的绝对路径。

Command Evidence 只保存：

- normalized command。
- cwd 相对路径。
- exitCode。
- timedOut。
- output excerpt。
- output hash。
- duration。

### `evidence-hash.ts`

使用 Node `crypto.createHash("sha256")`：

- 文件内容 hash。
- Artifact content canonical JSON hash。
- command output hash。

## 7.6 Tool Registry 统一采集

当前 `src/server/tools/registry.ts:25-37` 是所有工具执行的统一入口。

修改为：

```typescript
async execute(name, args, ctx) {
  const startedAt = Date.now();
  let result: ToolResult;
  try {
    result = await tool.handler(args, ctx);
  } catch (error) {
    result = normalizeToolError(error);
  }

  await evidenceCollector.capture({
    toolName: name,
    args,
    result,
    context: ctx,
    durationMs: Date.now() - startedAt
  });

  return result;
}
```

这样新工具默认进入统一证据管道，不再要求每个工具手动调用 evidence 函数。

保留工具内部特化逻辑的场景：

- `fs_write` 需要写入完成后重新读取文件计算最终 hash。
- `deploy_workspace` 需要拿 deployment/artifact ID。
- `ask_user` 的最终 answer 发生在异步 resolve API，不能只在第一次 tool handler 返回时采集。

## 7.7 补齐证据来源

修改：

- `src/server/tools/fs-write.ts`
- `src/server/tools/bash.ts`
- `src/server/tools/write-artifact.ts`
- `src/server/tools/read-artifact.ts`
- `src/server/tools/deploy-artifact.ts`
- `src/server/tools/deploy-workspace.ts`
- `src/server/tools/ask-user.ts`
- pending approval/question resolve service。

要求：

| 工具/事件 | Evidence type | 关键 payload |
|---|---|---|
| `fs_read` | `file_read` | path、contentHash、size |
| `fs_write` | `file_written` | path、action、beforeHash、afterHash |
| `bash` | `command_executed` / `test_executed` | command、exitCode、outputHash、excerpt |
| `read_artifact` | `artifact_read` | artifactId、version |
| `write_artifact` | `artifact_created` | artifactId、type、version、contentHash |
| `deploy_*` | `deployment_created` | deploymentId、artifactId、previewPath、status |
| 审批 resolve | `approval_resolved` | approvalId、approved/rejected |
| ask_user answer | `user_answered` | questionId、answer digest |
| report task | `task_reported` | report digest，不作为 verified evidence |

### 7.7.1 增加按需重读 Evidence 工具

新增：

```text
src/server/tools/read-evidence.ts
```

用途：

- Context 中只保存 Evidence 摘要和 evidenceId。
- Agent 确实需要更完整的清洗后错误信息时按需读取。
- 避免所有日志长期占用 Prompt。

约束：

1. evidenceId 必须属于当前 conversation。
2. 当前 child task 必须是 Evidence producer、直接下游或 FailureContext 引用方。
3. 只返回 sanitizer 处理后的 payload。
4. 不返回 Authorization、API Key、原始环境变量。
5. 单次返回设置字符上限和分页。
6. 每次读取再记录 `evidence_read` 审计记录，但不能递归记录完整 payload。

## 7.8 P1 测试

新增：

```text
src/server/evidence/evidence-collector.test.ts
src/server/repositories/evidence-repository.test.ts
src/server/repositories/task-attempt-repository.test.ts
```

扩展：

- `src/server/tools/tools.test.ts`
- `src/server/run-recovery.test.ts`

必须覆盖：

1. 服务重启后仍能查询 evidence。
2. 同一 task 两个 attempt 的 evidence 不混淆。
3. 工具失败也生成 diagnostic/invalid evidence。
4. API Key 和 Authorization 不进入 payload。
5. 大 stdout 只保存 excerpt + hash。
6. Artifact evidence 能证明 producer attempt。
7. Evidence insert 失败不会把 task 标记 verified。
8. `read_evidence` 不能跨 conversation 读取。
9. `read_evidence` 返回内容经过长度和敏感字段清洗。

## 7.9 P1 验收标准

- 所有子 Agent 工具调用都能追溯到 task attempt。
- 页面刷新和服务重启后证据仍存在。
- Evidence Ledger 不依赖 Agent 报告。
- 失败 attempt 的证据不会被删除。

---

# P2：实现会话级 Fact Registry、事实规范化和版本替换

## 8.1 目标

本阶段解决一个独立于“消息摘要”的关键问题：

> 用户在多轮会话中不断补充和修改项目要求时，系统如何把自然语言中的关键信息稳定地映射到同一个事实字段，并确保旧值失效、新值生效，而不是因为 Agent 每次生成不同 key 造成重复事实和上下文冲突。

例如以下表达必须被识别为同一个事实：

```text
主题色用蓝色。
主色不要蓝色了，改成绿色。
品牌主色换成 #22c55e。
```

最终都应映射到由 Runtime 管理的：

```text
ui.theme.primaryColor
```

而不是分别保存为：

```text
theme_color
primary_color
brand_main_color
ui.theme.primaryColor
```

本阶段采用以下混合方案：

```text
代码内置少量通用 Fact Definition
        +
当前 conversation 的动态 Fact Definition
        +
当前 conversation 的带版本 Fact Value
```

职责边界：

```text
Agent：
- 从用户消息中提取候选事实。
- 优先选择系统提供的 definitionId。
- 填写候选 value。
- 对未知事实提交 entity/property/value 提案。

Runtime：
- 决定 canonicalKey。
- 执行 Definition、Alias、entity/property 匹配。
- 校验 value 类型和作用域。
- 判断 replace/append/merge/no-op。
- 在事务中更新 active/superseded 状态。
- 保存来源、置信度和裁定方法。
```

关键原则：

- JSON 字段名由 Tool Schema 固定，不由 Agent 创建。
- Agent 输出的 proposedKey 只是候选，不是事实真实身份。
- `canonicalKey` 只能由 Runtime 从注册表解析或确定性生成。
- Context Compiler 只读取 `active` Fact。
- 低置信度候选不能覆盖已有 active Fact。
- 动态 Definition 只属于当前 conversation，删除会话时一并删除。

## 8.2 三类“key”必须明确区分

### 8.2.1 协议字段名

例如：

```json
{
  "definitionId": "...",
  "value": "...",
  "confidence": 0.98
}
```

其中 `definitionId`、`value`、`confidence` 是代码和 Zod Schema 固定的协议字段名，不是 Agent 动态生成的 Fact key。

### 8.2.2 Agent 候选 key

例如：

```json
{
  "proposedKey": "theme_color"
}
```

它只是 Agent 对未知事实的候选描述，必须标记为 untrusted，不能直接写入 `canonical_key`。

正常匹配路径应优先要求 Agent 输出 `definitionId`，而不是 proposedKey。

### 8.2.3 Runtime canonical key

例如：

```text
ui.theme.primaryColor
```

这是系统稳定的事实身份，由 Fact Registry 和 Canonicalizer 管理。

同一个 canonical key 可以有多个版本值，但同一时间通常只有一个 `active` 值：

```text
fact_01:
canonicalKey = ui.theme.primaryColor
value = #3b82f6
status = superseded

fact_02:
canonicalKey = ui.theme.primaryColor
value = #22c55e
status = active
supersedesFactId = fact_01
```

## 8.3 本阶段与 Evidence Ledger 的关系

Fact 和 Evidence 不能合并成同一概念：

```text
Fact：
系统当前认为有效的项目状态。

Evidence：
这个状态或任务结果的来源与证明。
```

例子：

```text
Fact:
ui.theme.primaryColor = #22c55e

Source evidence:
用户消息 msg_25 明确要求“主色改成绿色”
```

Fact 可以变化，Evidence 保持不可变。

当 Fact 被新值替换时：

- 旧 Fact 标记 `superseded`。
- 新 Fact 标记 `active`。
- 旧用户消息和旧 Evidence 不删除。
- Context Compiler 只注入新 Fact。
- 审计页面仍可追溯 Fact 版本链。

## 8.4 代码内置基础 Fact Definition

建议新增：

```text
src/shared/builtin-fact-definitions.ts
```

内置表只保存跨项目通用、语义稳定的少量 Definition：

```typescript
export type FactValueType =
  | "string"
  | "number"
  | "boolean"
  | "color"
  | "string_array"
  | "json";

export type FactUpdatePolicy =
  | "replace"
  | "append"
  | "merge";

export interface FactDefinition {
  id: string;
  canonicalKey: string;
  namespace: string;
  entityType: string;
  property: string;
  valueType: FactValueType;
  updatePolicy: FactUpdatePolicy;
  description: string;
  aliases: string[];
  applicableTaskTags: string[];
  applicableAgentRoles: string[];
  origin: "builtin" | "conversation";
}

export const BUILTIN_FACT_DEFINITIONS: FactDefinition[] = [
  {
    id: "builtin_project_goal",
    canonicalKey: "project.goal",
    namespace: "project",
    entityType: "project",
    property: "goal",
    valueType: "string",
    updatePolicy: "replace",
    description: "当前项目的主要目标",
    aliases: ["project_goal", "项目目标", "产品目标"],
    applicableTaskTags: ["planning", "design", "implementation", "review"],
    applicableAgentRoles: ["conductor", "pm", "ui", "frontend", "reviewer"],
    origin: "builtin"
  },
  {
    id: "builtin_frontend_framework",
    canonicalKey: "technical.frontend.framework",
    namespace: "technical.frontend",
    entityType: "frontend",
    property: "framework",
    valueType: "string",
    updatePolicy: "replace",
    description: "前端技术框架",
    aliases: ["frontend_framework", "前端框架", "ui_framework"],
    applicableTaskTags: ["planning", "implementation", "review"],
    applicableAgentRoles: ["conductor", "frontend", "reviewer"],
    origin: "builtin"
  },
  {
    id: "builtin_ui_primary_color",
    canonicalKey: "ui.theme.primaryColor",
    namespace: "ui.theme",
    entityType: "global_theme",
    property: "primary_color",
    valueType: "color",
    updatePolicy: "replace",
    description: "应用全局主题主色",
    aliases: ["theme_color", "primary_color", "brand_color", "主色", "主题颜色"],
    applicableTaskTags: ["design", "implementation", "review"],
    applicableAgentRoles: ["conductor", "ui", "frontend", "reviewer"],
    origin: "builtin"
  },
  {
    id: "builtin_auth_required",
    canonicalKey: "feature.auth.required",
    namespace: "feature.auth",
    entityType: "authentication",
    property: "required",
    valueType: "boolean",
    updatePolicy: "replace",
    description: "产品是否需要登录或认证功能",
    aliases: ["auth_required", "login_required", "需要登录", "认证需求"],
    applicableTaskTags: ["planning", "implementation", "review"],
    applicableAgentRoles: ["conductor", "pm", "frontend", "reviewer"],
    origin: "builtin"
  }
];
```

内置 Definition 的边界：

- 只包含高频、稳定、跨项目通用字段。
- 不尝试穷举每个产品领域的全部业务事实。
- 不直接保存 Fact value。
- 在代码版本中维护和评审。
- `id` 和 `canonicalKey` 一旦发布不得随意修改。

运行时可以把内置 Definition 作为只读虚拟注册表，不必复制到每个 conversation。

## 8.5 会话级动态 Fact Definition

用户项目特有字段不应硬编码，例如：

```text
pomodoro.defaultWorkDurationMinutes
todo.taskCard.completedColor
editor.autoSaveIntervalSeconds
```

这些 Definition 只保存在当前 conversation。

建议新增 SQLite 表：

```sql
CREATE TABLE IF NOT EXISTS conversation_fact_definitions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL
    REFERENCES conversations(id) ON DELETE CASCADE,
  canonical_key TEXT NOT NULL,
  namespace TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  property_name TEXT NOT NULL,
  value_type TEXT NOT NULL,
  update_policy TEXT NOT NULL DEFAULT 'replace',
  description TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  applicable_task_tags_json TEXT NOT NULL DEFAULT '[]',
  applicable_agent_roles_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  origin TEXT NOT NULL DEFAULT 'conversation',
  proposed_by_agent_id TEXT,
  source_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(conversation_id, canonical_key)
);
```

状态：

```text
pending：候选 Definition，尚未允许覆盖事实。
active：当前会话可用 Definition。
merged：已合并到另一个 canonical Definition。
deprecated：保留审计，不再用于新 Fact。
```

对于 `merged` Definition 应增加：

```sql
merged_into_definition_id TEXT
```

使历史候选 key 能解析到最终 canonical Definition。

## 8.6 会话级 Fact Value

建议新增 SQLite 表：

```sql
CREATE TABLE IF NOT EXISTS conversation_facts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL
    REFERENCES conversations(id) ON DELETE CASCADE,
  definition_id TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  value_type TEXT NOT NULL,
  status TEXT NOT NULL,
  trust_level TEXT NOT NULL,
  confidence REAL NOT NULL,
  resolution_method TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  supersedes_fact_id TEXT,
  invalidated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

字段说明：

- `definition_id` 可以引用代码内置 ID 或 conversation 动态 Definition ID。
- `canonical_key` 冗余保存，方便查询和历史 Definition 合并。
- `value_json` 统一保存 JSON 序列化值。
- `status`：`active | superseded | pending | rejected`。
- `trust_level`：沿用 Evidence-aware 信任级别。
- `resolution_method`：记录系统如何裁定 key。
- `source_type`：`message | user_answer | evidence | agent_proposal`。
- `source_id`：通常是 messageId、pendingQuestionId 或 evidenceId。
- `supersedes_fact_id`：形成版本链。

索引：

```sql
CREATE INDEX IF NOT EXISTS idx_conversation_facts_active
ON conversation_facts(conversation_id, canonical_key, status);

CREATE INDEX IF NOT EXISTS idx_conversation_facts_source
ON conversation_facts(source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_conversation_fact_definitions_lookup
ON conversation_fact_definitions(conversation_id, namespace, entity_type, property_name);
```

V1 以 `replace` 单值事实为主。

`append` / `merge` 类型不能直接套用“一个 canonical key 只有一个 active Fact”的约束，应由 Fact Service 按 Definition policy 处理。

## 8.7 事实来源记录

同一个值可能被用户多次确认：

```text
msg_10：主色用绿色。
msg_18：对，绿色保持不变。
```

新值与当前 active value 完全相同时，不应创建新的 Fact version，但应保留新来源。

建议新增：

```sql
CREATE TABLE IF NOT EXISTS conversation_fact_sources (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL
    REFERENCES conversations(id) ON DELETE CASCADE,
  fact_id TEXT NOT NULL
    REFERENCES conversation_facts(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_excerpt TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(fact_id, source_type, source_id)
);
```

这样可以区分：

- Fact value 没变化。
- 但它获得了新的用户确认来源。

## 8.8 共享类型

建议新增：

```text
src/shared/context-fact-types.ts
```

核心类型：

```typescript
export interface ConversationFact {
  id: string;
  conversationId: string;
  definitionId: string;
  canonicalKey: string;
  value: unknown;
  valueType: FactValueType;
  status: "active" | "superseded" | "pending" | "rejected";
  trustLevel: EvidenceTrustLevel;
  confidence: number;
  resolutionMethod:
    | "definition_id"
    | "canonical_key"
    | "alias"
    | "entity_property"
    | "new_definition"
    | "manual_confirmation";
  sourceType: "message" | "user_answer" | "evidence" | "agent_proposal";
  sourceId: string;
  supersedesFactId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CandidateFactUpdate {
  definitionId?: string;
  proposedKey?: string;
  entity?: string;
  property?: string;
  value: unknown;
  valueType?: FactValueType;
  confidence: number;
  sourceExcerpt?: string;
}

export interface CandidateFactDefinition {
  proposedNamespace?: string;
  entity: string;
  property: string;
  value: unknown;
  valueType: FactValueType;
  description: string;
  aliases?: string[];
  confidence: number;
  sourceExcerpt?: string;
}

export interface FactResolution {
  status: "matched" | "created" | "pending" | "no_change" | "rejected";
  definition: FactDefinition | null;
  canonicalKey: string | null;
  previousFact: ConversationFact | null;
  nextFact: ConversationFact | null;
  confidence: number;
  resolutionMethod: ConversationFact["resolutionMethod"] | null;
  reason: string;
}
```

## 8.9 Conductor 事实提取阶段

为了避免 Conductor 直接进入 `ask_user` 或 `plan_tasks` 而遗漏关键事实，建议在正式 planning 前增加独立阶段：

```text
received
-> extracting_facts
-> clarifying 或 planning
-> awaiting_approval
-> executing
```

活动入口位于统一后的：

```text
src/server/conductor-service.ts
```

建议新增：

```text
src/server/context-facts/conductor-fact-extraction.ts
```

签名：

```typescript
export async function extractFactsForUserTurn(input: {
  conversationId: string;
  conductorRunId: string;
  conductorAgent: Agent;
  triggerMessage: Message;
  signal: AbortSignal;
}): Promise<FactResolution[]>
```

执行步骤：

1. 读取用户当前消息。
2. 加载内置 Definition。
3. 加载当前 conversation 的 active/pending Definition。
4. 加载当前 conversation 的 active Fact。
5. 根据消息主题先筛选相关 Definition。
6. 将筛选结果和当前值提供给 Conductor。
7. Conductor 输出 `updates` 和 `proposals`。
8. Runtime 调用 Canonicalizer。
9. 在 SQLite transaction 中应用可自动确认的更新。
10. 将 pending 候选保存但不注入正常任务上下文。
11. planning 阶段重新读取最新 active Facts。

为了控制成本：

- 只对 Conductor 接收的用户任务消息执行。
- 普通“你好”“谢谢”等短消息可通过轻量规则跳过。
- 单轮最多处理 20 个 update、5 个 new Definition proposal。
- 事实提取失败不能阻塞普通聊天，但必须记录诊断。

## 8.10 Fact Registry 提供给 Agent 的方式

不能把完整 Fact Registry 全量塞给模型。

系统应先按以下条件筛选：

- 当前 Agent role。
- 当前 task tags。
- Plan 中声明的 fact namespace。
- 当前用户消息出现的实体和属性。
- 当前 active Fact 的 namespace。

提供给 Conductor 的结构：

```json
{
  "availableDefinitions": [
    {
      "definitionId": "builtin_ui_primary_color",
      "canonicalKey": "ui.theme.primaryColor",
      "description": "应用全局主题主色",
      "valueType": "color",
      "currentValue": "#3b82f6"
    }
  ]
}
```

这里的 `currentValue` 只是给模型查看的 DTO 字段。

持久化 Fact 仍统一使用：

```json
{
  "canonicalKey": "ui.theme.primaryColor",
  "value": "#3b82f6"
}
```

为避免字段语义混乱，推荐进一步改成嵌套结构：

```json
{
  "definition": {
    "id": "builtin_ui_primary_color",
    "canonicalKey": "ui.theme.primaryColor",
    "valueType": "color"
  },
  "activeFact": {
    "id": "fact_01",
    "value": "#3b82f6"
  }
}
```

## 8.11 Fact Tool

建议新增：

```text
src/server/tools/update-context-facts.ts
```

Tool schema：

```typescript
const UpdateContextFactsSchema = z.object({
  updates: z.array(z.object({
    definitionId: z.string().optional(),
    proposedKey: z.string().optional(),
    entity: z.string().optional(),
    property: z.string().optional(),
    value: z.unknown(),
    valueType: factValueTypeSchema.optional(),
    confidence: z.number().min(0).max(1),
    sourceExcerpt: z.string().max(300).optional()
  })).max(20).default([]),
  proposals: z.array(z.object({
    proposedNamespace: z.string().optional(),
    entity: z.string(),
    property: z.string(),
    value: z.unknown(),
    valueType: factValueTypeSchema,
    description: z.string().min(1).max(300),
    aliases: z.array(z.string()).max(10).optional(),
    confidence: z.number().min(0).max(1),
    sourceExcerpt: z.string().max(300).optional()
  })).max(5).default([])
});
```

ToolContext 必须提供：

- `conversationId`
- `runId`
- `agentId`
- `triggerMessageId`

`sourceId` 由 Runtime 从 ToolContext 写入，不能接受 Agent 自己传入任意 messageId。

Tool 返回：

```json
{
  "updated": [],
  "created": [],
  "pending": [],
  "rejected": [],
  "unchanged": []
}
```

Conductor 不能直接执行 SQL。

## 8.12 Fact Canonicalizer

建议新增：

```text
src/server/context-facts/fact-registry.ts
src/server/context-facts/fact-canonicalizer.ts
src/server/context-facts/fact-value-validator.ts
src/server/context-facts/fact-key-generator.ts
src/server/context-facts/fact-update-service.ts
src/server/context-facts/fact-repository.ts
```

Canonicalizer 按固定顺序匹配：

### 第 1 级：definitionId 精确匹配

```text
Agent 输出 builtin_ui_primary_color
-> 直接解析 ui.theme.primaryColor
-> confidence = 1.0
```

### 第 2 级：canonicalKey 精确匹配

只有在兼容旧客户端时使用。

Agent 提供的字符串必须先规范化大小写和空白，但不能创建新 canonical key。

### 第 3 级：Alias 精确匹配

```text
theme_color
primary_color
主色
-> ui.theme.primaryColor
```

多个 Definition 命中同一 Alias 时不能自动更新，进入 pending。

### 第 4 级：entity + property 匹配

```text
entity = global_theme
property = primary_color
-> ui.theme.primaryColor
```

必须同时考虑 conversation scope，避免把：

```text
global_theme.primary_color
submit_button.background_color
```

错误合并。

### 第 5 级：新 Definition 提案

仅当以上匹配均失败时进入。

Runtime 根据：

- namespace allowlist。
- entity。
- property。
- valueType。
- 当前 conversation 已有 Definition。

确定性生成 canonical key。

Agent 的 proposedNamespace 仅作为建议。

## 8.13 Canonical key 确定性生成

`fact-key-generator.ts` 不调用 LLM。

建议规则：

```text
normalized namespace
+
normalized entity/property
```

例如：

```text
entity = pomodoro_timer
property = default_work_duration
valueType = number

Runtime:
pomodoro.defaultWorkDurationMinutes
```

领域单位必须进入 property：

```text
defaultWorkDurationMinutes
```

不能只生成：

```text
defaultWorkDuration
```

如果单位无法确定，Definition 必须保持 pending 并要求澄清。

生成后必须检查：

- conversation 内 canonical key 唯一。
- 与内置 Definition 不冲突。
- 与 Alias 不冲突。
- 与已有 entity/property 不重复。

## 8.14 匹配置信度和裁定

建议阈值：

```text
definitionId 精确匹配：1.00，自动处理
canonicalKey 精确匹配：1.00，自动处理
唯一 Alias 匹配：0.95，自动处理
entity + property 精确匹配：0.90，自动处理
语义相似但字段不同：0.70~0.89，pending
无法匹配的新字段：创建 Definition proposal
```

置信度只是门槛之一。

即使 confidence 高，以下情况仍不能自动覆盖：

- 新值类型不合法。
- 来源不是用户消息或已验证 Evidence。
- 当前 active Fact 的 trust level 更高。
- value 语义存在单位歧义。
- 多个 Definition 同时匹配。
- updatePolicy 不允许 replace。

## 8.15 Value 类型校验

`fact-value-validator.ts` 至少实现：

```text
string：非空、长度限制
number：有限数值、可选范围
boolean：只允许 true/false
color：HEX/RGB/HSL/受控颜色名
string_array：去重、数量限制
json：限制深度和 payload 大小
```

颜色示例：

```text
“绿色”
```

可以保存为：

```json
{
  "semantic": "green",
  "resolved": "#22c55e"
}
```

如果用户只说“绿色”而没有指定具体色值，系统不能假装用户明确选择了某个 HEX。

更安全的方式是：

```text
value = "green"
valueType = color
```

由 UI Agent 在设计阶段提出具体色值，Reviewer 再验证设计约束是否满足“绿色”。

## 8.16 Fact 更新算法

`fact-update-service.ts` 使用 SQLite transaction。

### 情况一：没有 active Fact

```text
创建新 Fact
status = active
```

### 情况二：新值和 active value 相同

```text
不创建新版本
给当前 Fact 增加 source observation
返回 no_change
```

### 情况三：Definition policy = replace

```text
旧 Fact -> superseded
新 Fact -> active
新 Fact.supersedesFactId = 旧 Fact.id
```

这两个更新必须在同一个事务内完成。

### 情况四：Definition policy = append

```text
保留旧 active Facts
新增一个 active Fact
```

必须按 canonicalized value 去重。

### 情况五：Definition policy = merge

只适用于结构化 JSON。

Runtime 根据 Definition 的 merge schema 合并，不能让 Agent自由决定 merge 规则。

### 情况六：低置信度或冲突

```text
新 Fact -> pending
旧 active Fact 保持 active
```

不能先 supersede 再等待确认。

## 8.17 用户修改颜色的完整例子

当前 active Fact：

```json
{
  "id": "fact_01",
  "definitionId": "builtin_ui_primary_color",
  "canonicalKey": "ui.theme.primaryColor",
  "value": "#3b82f6",
  "status": "active",
  "sourceId": "msg_10"
}
```

用户消息：

```text
主色不要蓝色了，改成绿色。
```

系统提供给 Conductor 的相关 Definition：

```json
{
  "definition": {
    "id": "builtin_ui_primary_color",
    "canonicalKey": "ui.theme.primaryColor",
    "valueType": "color",
    "description": "应用全局主题主色"
  },
  "activeFact": {
    "id": "fact_01",
    "value": "#3b82f6"
  }
}
```

Conductor 输出候选：

```json
{
  "updates": [
    {
      "definitionId": "builtin_ui_primary_color",
      "value": "green",
      "confidence": 0.99,
      "sourceExcerpt": "主色不要蓝色了，改成绿色"
    }
  ],
  "proposals": []
}
```

Runtime：

```text
definitionId 精确匹配
-> canonicalKey = ui.theme.primaryColor
-> valueType=color 校验通过
-> updatePolicy=replace
-> 来源为用户当前消息
-> 执行事务
```

结果：

```text
fact_01.status = superseded

fact_02:
definitionId = builtin_ui_primary_color
canonicalKey = ui.theme.primaryColor
value = "green"
status = active
supersedesFactId = fact_01
sourceId = 当前用户 messageId
```

后续 Context Compiler 只读取 `fact_02`。

## 8.18 动态扩展示例

用户消息：

```text
默认工作时间设置成 25 分钟。
```

内置和 conversation Definition 中都没有这个字段。

Conductor 输出：

```json
{
  "updates": [],
  "proposals": [
    {
      "entity": "pomodoro_timer",
      "property": "default_work_duration",
      "value": 25,
      "valueType": "number",
      "description": "番茄时钟默认工作阶段时长，单位分钟",
      "confidence": 0.98,
      "sourceExcerpt": "默认工作时间设置成 25 分钟"
    }
  ]
}
```

Runtime：

1. 查找内置 Definition。
2. 查找 conversation Definition。
3. 查找 Alias。
4. 查找 entity/property。
5. 均未匹配。
6. 确认用户明确给出值和单位。
7. 生成：

```text
pomodoro.defaultWorkDurationMinutes
```

8. 创建 conversation Definition。
9. 创建 active Fact。

该 Definition 和 Fact 只属于当前 conversation。

另一个 conversation 可以有自己的：

```text
pomodoro.defaultWorkDurationMinutes = 50
```

两者互不影响。

## 8.19 Fact 与 Conductor Plan 的连接

建议扩展 `ParsedTask`：

```typescript
factRequirements?: {
  requiredKeys?: string[];
  namespaces?: string[];
  taskTags?: string[];
};
```

示例：

```json
{
  "id": "t2",
  "agentId": "ag_ui",
  "factRequirements": {
    "requiredKeys": [
      "ui.theme.primaryColor"
    ],
    "namespaces": [
      "project",
      "ui.theme",
      "feature"
    ],
    "taskTags": [
      "design"
    ]
  }
}
```

Context Compiler 选择顺序：

1. `requiredKeys` 对应 active Fact。
2. `namespaces` 下与 Agent role 匹配的 active Fact。
3. 与 task tags 相关的 active Fact。
4. 相关性召回的 optional Fact。

required Fact 不存在时：

- 不允许 Agent 猜测。
- task 标记 blocked 或 Conductor 先 ask_user。

## 8.20 Fact 注入 Task Context

后续 Task Context Envelope 增加：

```typescript
facts: Array<{
  factId: string;
  definitionId: string;
  canonicalKey: string;
  value: unknown;
  trustLevel: EvidenceTrustLevel;
  sourceId: string;
  reason: string;
}>;
```

Prompt 只注入相关 active Fact：

```xml
<active_facts>
  <fact
    key="ui.theme.primaryColor"
    source="msg_25"
    trust="authoritative">
    green
  </fact>
</active_facts>
```

禁止注入：

- superseded Fact。
- rejected Fact。
- 未确认 pending Fact。
- 与当前 task 无关的 namespace。

Context Manifest 对被排除的旧 Fact 记录：

```json
{
  "sourceType": "fact",
  "sourceId": "fact_01",
  "included": false,
  "omittedReason": "stale",
  "reason": "已被 fact_02 替代"
}
```

## 8.21 Fact 对上下文压缩的影响

Conversation Summary 不再是关键事实的唯一来源。

最终优先级：

```text
active authoritative Fact
> verified Evidence / accepted task result
> conversation working summary
> retrieved history
> Agent report
```

如果 Summary 仍写着：

```text
主题色为蓝色。
```

但 Fact Store 为：

```text
ui.theme.primaryColor = green
status = active
```

Context Compiler 必须：

- 注入 green。
- 不注入旧 blue。
- 在必要时将 Summary 中的 blue 视为 stale。

因此滚动摘要发生漂移时，也不会覆盖结构化 active Fact。

## 8.22 API

建议新增：

```text
GET  /api/conversations/:id/fact-definitions
GET  /api/conversations/:id/facts
GET  /api/conversations/:id/facts/history?canonicalKey=...
POST /api/conversations/:id/fact-proposals/:proposalId/resolve
```

默认 GET facts 只返回 active。

调试参数可以返回：

```text
active
superseded
pending
rejected
```

resolve API 支持：

```text
approve：确认新 Definition 或 pending Fact。
merge：合并到已有 Definition。
reject：拒绝候选。
```

## 8.23 UI

本阶段后端完成不强制立即制作完整 Fact 管理页，但至少应在 Context 详情中显示：

- canonical key。
- active value。
- source。
- 更新时间。
- 是否替代旧值。

后续可新增：

```text
src/components/context-fact-panel.tsx
src/components/context-fact-history-dialog.tsx
src/components/pending-fact-proposals.tsx
```

用户可以：

- 查看当前有效事实。
- 查看版本历史。
- 确认 pending 提案。
- 手动纠正错误匹配。
- 将 conversation 动态 Definition 合并到已有 Definition。

## 8.24 具体修改文件

新增：

```text
src/shared/builtin-fact-definitions.ts
src/shared/context-fact-types.ts
src/server/context-facts/fact-registry.ts
src/server/context-facts/fact-canonicalizer.ts
src/server/context-facts/fact-value-validator.ts
src/server/context-facts/fact-key-generator.ts
src/server/context-facts/fact-update-service.ts
src/server/context-facts/fact-repository.ts
src/server/context-facts/conductor-fact-extraction.ts
src/server/tools/update-context-facts.ts
```

修改：

- `src/db/schema.ts`：增加 conversation Fact 三张表。
- `src/db/bootstrap.ts`：增加建表、索引和升级逻辑。
- `src/shared/ids.ts`：增加 Fact/Definition/Source ID。
- `src/server/tools/registry.ts`：注册 `update_context_facts`。
- `src/server/tools/types.ts`：ToolContext 增加 triggerMessageId。
- `src/server/adapters/types.ts`：AdapterInput 保留 trigger message identity。
- `src/server/adapters/custom-agent-adapter.ts`：传递 triggerMessageId。
- `src/server/conductor-service.ts`：增加 extracting_facts 阶段。
- `src/server/tools/conductor-tools.ts`：Plan 增加 factRequirements。
- `src/server/task-context/context-compiler.ts`：读取 task 相关 active Facts。
- `src/shared/task-context-types.ts`：Envelope 增加 facts。

## 8.25 P2 测试

新增：

```text
src/server/context-facts/fact-registry.test.ts
src/server/context-facts/fact-canonicalizer.test.ts
src/server/context-facts/fact-value-validator.test.ts
src/server/context-facts/fact-key-generator.test.ts
src/server/context-facts/fact-update-service.test.ts
src/server/context-facts/conductor-fact-extraction.test.ts
src/server/tools/update-context-facts.test.ts
```

扩展：

- `src/db/bootstrap.test.ts`
- `src/server/conductor-service.test.ts`
- `src/server/task-context/context-compiler.test.ts`

必须覆盖：

1. definitionId 精确匹配。
2. `theme_color` Alias 匹配到 `ui.theme.primaryColor`。
3. entity/property 匹配相同事实。
4. global theme color 不会错误匹配 submit button color。
5. 新值替代旧值时形成 supersedes 链。
6. 新值相同只增加 source，不创建新版本。
7. 低置信度候选不覆盖 active Fact。
8. valueType 不合法时拒绝。
9. 用户新领域字段可以创建 conversation Definition。
10. 不同 conversation 的动态 Definition 和 Fact 隔离。
11. 删除 conversation 后动态 Definition、Fact、source 自动删除。
12. Summary 旧值不能覆盖 active Fact。
13. Context Compiler 不注入 superseded/pending Fact。
14. 并发更新同一个 replace Fact 时最终只有一个 active 版本。
15. Agent 伪造 sourceMessageId 时由 Runtime 忽略。
16. 单轮新 Definition 超过限制时拒绝。

## 8.26 P2 验收标准

- 代码内置一组最小通用 Fact Definition。
- Conductor 可以基于用户任务消息提取候选 Fact。
- 正常路径优先使用 definitionId，不依赖 Agent 自由生成 key。
- Runtime 可以将 Alias 和 entity/property 映射到 canonical key。
- 未知领域事实可以扩展为 conversation 动态 Definition。
- 动态 Definition 和 Fact 不跨 conversation 泄漏。
- replace Fact 更新后旧值 superseded、新值 active。
- 低置信度和冲突候选不会破坏现有 active Fact。
- Context Compiler 只消费相关 active Fact。
- 所有 Fact 都能追溯到用户消息、用户回答或 verified Evidence。

---

# P3：实现 Task Context Compiler 和 Context Snapshot

## 9.1 目标

将当前 child prompt 拼接升级为：

```text
数据收集
  -> 策略过滤
  -> 可信度过滤
  -> DAG 依赖过滤
  -> Token 预算
  -> Context Manifest
  -> Snapshot 持久化
  -> Prompt Renderer
```

## 9.2 新增模块

```text
src/server/task-context/context-compiler.ts
src/server/task-context/context-policy.ts
src/server/task-context/context-candidates.ts
src/server/task-context/qualification-filter.ts
src/server/task-context/relevance-ranker.ts
src/server/task-context/context-compressor.ts
src/server/task-context/context-externalizer.ts
src/server/task-context/context-packer.ts
src/server/task-context/context-budget.ts
src/server/task-context/context-renderer.ts
src/server/task-context/context-manifest.ts
src/server/task-context/failure-context.ts
```

## 9.3 `context-compiler.ts`

建议签名：

```typescript
export interface CompileTaskContextInput {
  conversationId: string;
  conductorRunId: string;
  planId: string;
  planRevision: number;
  task: ParsedTask;
  attemptId: string;
  attempt: number;
  assignedAgent: Agent;
  triggerMessage: Message;
  resolvedInputs: ResolvedInput[];
  previousAttemptId?: string;
}

export async function compileTaskContext(
  input: CompileTaskContextInput
): Promise<TaskContextEnvelope>
```

执行步骤必须固定：

1. 校验 task identity。
2. 加载 conversation 和当前 Plan revision。
3. 加入任务目标。
4. 加入用户原始请求。
5. 根据 task.factRequirements 加载相关 active Facts。
6. 检查 required Fact 是否存在；缺失时阻塞或交回 Conductor 澄清。
7. 加入仍有效的用户确认和 pinned 约束。
8. 解析直接依赖的 verified outputs。
9. 加载相关 Artifact metadata，不内联全文。
10. 编译 Evidence Contract。
11. attempt > 1 时构建 FailureContext。
12. 根据 targetPaths 生成 Workspace Snapshot。
13. 可选检索相关历史。
14. 去重并排除 superseded/pending/rejected Fact。
15. 计算 Token 预算。
16. 生成 manifest。
17. 保存 snapshot。
18. 返回 immutable envelope。

### 9.3.1 Candidate Collector

`context-candidates.ts` 将不同来源统一转换为：

```typescript
export interface ContextCandidate {
  id: string;
  category:
    | "task"
    | "fact"
    | "upstream_input"
    | "workspace"
    | "evidence"
    | "failure"
    | "recent_message"
    | "retrieved_history";
  sourceType: string;
  sourceId: string;
  content: unknown;
  trustLevel: EvidenceTrustLevel;
  required: boolean;
  taskIds: string[];
  namespaces: string[];
  pathRefs: string[];
  criterionIds: string[];
  tokenEstimate: number;
  createdAt: number;
}
```

Collector 只负责收集，不负责决定是否进入。

必须从以下来源产生 candidate：

- task objective 和 Plan contract。
- conversation active Facts。
- verified output bindings。
- direct dependency task delta。
- Workspace target paths。
- 当前 attempt 和上一 attempt Evidence。
- FailureContext。
- recent messages。
- P8 retrieval results。

### 9.3.2 Qualification Filter

`qualification-filter.ts` 实现确定性 Hard Filter：

```typescript
export type QualificationDecision =
  | { qualified: true; reason: string }
  | {
      qualified: false;
      reasonCode:
        | "wrong_conversation"
        | "unrelated_dag_branch"
        | "unverified_output"
        | "superseded_fact"
        | "pending_fact"
        | "rejected_fact"
        | "stale_evidence"
        | "private_agent_trace"
        | "scope_denied";
      reason: string;
    };
```

过滤顺序：

1. conversation scope。
2. Agent/task scope。
3. DAG dependency。
4. Fact lifecycle。
5. task verification。
6. Evidence status。
7. privacy/trace policy。

每个被排除 candidate 仍写入 Manifest：

```json
{
  "sourceId": "art_style_01",
  "included": false,
  "omittedReason": "unverified",
  "reason": "producer task t2 attempt 1 verification rejected"
}
```

Hard Filter 不调用 LLM。

### 9.3.3 Relevance Ranker

`relevance-ranker.ts` 只处理 qualified candidate。

V1 使用可解释规则评分，不先引入 embedding：

```typescript
score =
  requiredWeight
  + directDependencyWeight
  + factRequirementWeight
  + criterionWeight
  + targetPathWeight
  + failureWeight
  + recencyWeight
  + sourceTrustWeight;
```

建议权重：

```text
required=true                       +1000
current task definition             +900
required active Fact                +850
direct verified input               +800
Acceptance Criterion                +800
FailureContext                      +780
targetPaths 直接命中                +650
criterion evidence                  +620
task namespace active Fact          +550
verified upstream summary           +500
recent user message                 +300
retrieved history                   +100~300
reference-only metadata             +80
```

排序结果必须保存：

```typescript
{
  score: number;
  scoreReasons: string[];
}
```

不能只保存一个不可解释的浮点分数。

P8 可以增加 FTS/embedding 分数，但不能覆盖 required、verified 和 trust 规则。

### 9.3.4 Context Compressor

`context-compressor.ts` 根据 category 使用不同压缩器：

```typescript
interface ContextCompressionStrategy {
  supports(candidate: ContextCandidate): boolean;
  compress(candidate: ContextCandidate, budget: number): Promise<CompressedContextItem>;
}
```

V1 策略：

| Candidate | 压缩结果 |
|---|---|
| Fact | canonicalKey + value + source |
| Artifact | id + version + verified task summary |
| File | relative path + hash + 相关片段 |
| Command | command + exitCode + error excerpt + evidenceId |
| Test | passed/failed count + failure names + evidenceId |
| Task result | verified summary + output bindings |
| Recent message | 原文或短截取 |
| Historical branch | 结构化摘要 + source IDs |

压缩器必须遵守：

- 不改写 canonical key。
- 不改变 pass/fail。
- 不把 rejected 说成 complete。
- 保留 ID、hash、path、exitCode 等结构锚点。
- LLM 摘要失败时不能降级为无边界全文拼接。

对于 Mandatory Fact 和 Criterion，默认不调用 LLM 压缩。

### 9.3.5 Context Externalizer

`context-externalizer.ts` 将大对象转换为可按需读取的 reference：

```typescript
interface ExternalContextReference {
  refType: "artifact" | "file" | "evidence";
  refId: string;
  title: string;
  summary: string;
  contentHash?: string;
  readTool: "read_artifact" | "fs_read" | "read_evidence";
}
```

示例：

```json
{
  "refType": "evidence",
  "refId": "ev_build_01",
  "summary": "pnpm build failed: TS2322 at src/App.tsx:42",
  "readTool": "read_evidence"
}
```

Externalizer 不能让 Agent 读取无权限的 Evidence 或任意文件。

### 9.3.6 Token Budget Packer

`context-packer.ts` 按 section 和 rank 装箱：

```typescript
export function packContext(
  candidates: RankedCompressedContextItem[],
  budget: TaskContextTokenBudget
): PackedTaskContext
```

算法：

1. 先计算所有 Mandatory item。
2. Mandatory 超预算立即失败。
3. 加入 High item，按 score 降序。
4. 加入 Optional item，按 score/tokenRatio 降序。
5. Reference-only metadata 使用独立小预算。
6. 为 Prompt framing 保留固定 margin。
7. 所有未加入 item 写 Manifest。

推荐分配：

```text
Mandatory：实际需要多少就保留多少。
High：剩余预算的 60%。
Optional：剩余预算的 30%。
Reference-only metadata：剩余预算的 10%。
```

当 High 没用满时可把余额交给 Optional；Optional 不能反向挤占 Mandatory。

V1 使用贪心装箱即可，不需要实现复杂背包算法。

## 9.4 上下文候选优先级

### 必须注入，不可裁剪

1. Task identity、objective。
2. 用户硬约束。
3. task.requiredFactKeys 对应的 active authoritative Facts。
4. Acceptance Criteria / Evidence Contract。
5. required inputs 对应的 verified Artifact refs。
6. expected outputs。
7. 当前 FailureContext。

### 高优先级

1. targetPaths 当前状态。
2. task namespace 下的其他 active Facts。
3. 已确认设计决策。
4. 与任务直接相关的用户回答。
5. 上游 task 的 verified summary。

### 可选

1. 相关历史消息。
2. 非 required input。
3. 同路径的近期工具诊断。

### 禁止注入

1. 未验证 Artifact 作为事实。
2. 无依赖旁支任务输出。
3. 其他 Agent thinking。
4. 完整 tool result。
5. superseded、pending、rejected Fact。
6. 已 superseded 决策。
7. 上一 attempt 已成功且与失败无关的冗长过程。

## 9.5 Token 预算

`context-budget.ts` 不复用当前 conversation 的简单 20 条消息逻辑，而是面向 task envelope 计算：

```typescript
availableTaskContext =
  contextWindow
  - systemPromptTokens
  - toolSchemaTokens
  - currentTaskInstructionTokens
  - outputReserve
  - protocolMargin;
```

裁剪顺序：

```text
retrieved history
-> optional workspace context
-> optional upstream summaries
-> non-required inputs
```

如果 mandatory context 已超预算：

- 不调用模型。
- attempt 标记 `blocked`。
- error category 使用 `task_context_overflow`。
- 返回每个 mandatory section 的 token 明细。

## 9.6 改造 `child-prompt-builder.ts`

当前：

- `:26-33` 定义输入。
- `:68-189` 同时承担数据组织和 Prompt 渲染。

目标：

1. `resolveTaskInputs()` 可以保留，但只解析绑定。
2. `buildChildTaskPrompt()` 改名为 `renderTaskContextPrompt()`。
3. 参数只接收 `TaskContextEnvelope`。
4. 不再在 renderer 内查询 DB 或决定上下文选择。
5. 所有 XML 内容必须 escape，包括当前未 escape 的 `task.prompt`。

建议输出：

```xml
<task_context
  context_id="ctx_xxx"
  policy_version="evidence-context-v1"
  task_id="t3"
  attempt="2">
  <objective>...</objective>
  <constraints>...</constraints>
  <verified_inputs>...</verified_inputs>
  <workspace_state>...</workspace_state>
  <evidence_contract>...</evidence_contract>
  <failure_context>...</failure_context>
</task_context>

<your_task>...</your_task>
```

Prompt 中明确：

- verified input 可以作为事实使用。
- reported/unverified 只能用于诊断。
- 完成后必须调用 `report_task_result`。
- report 不是验收结论，Runtime 会独立校验证据。

## 9.7 改造 Conductor child dispatch

当前主要位置：

- `src/server/orchestrator-service.ts:438-472`
- `src/server/orchestrator-service.ts:479-525`

修改为：

```typescript
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  const attemptRecord = createTaskAttempt(...);
  const envelope = await compileTaskContext(...);
  persistContextSnapshot(envelope);
  attachSnapshotToAttempt(attemptRecord.id, envelope.identity.contextSnapshotId);
  const prompt = renderTaskContextPrompt(envelope);
  const handle = startAgentRun({ ..., taskExecution: envelope.identity });
  ...
}
```

不得在 retry 时使用旧 `prompt` 字符串继续拼接。

## 9.8 Context Manifest

每次编译必须保存：

- included items。
- omitted items。
- source ID。
- inclusion reason。
- trust level。
- token estimate。
- omitted reason。

示例：

```json
{
  "sourceType": "artifact",
  "sourceId": "art_prd_1",
  "reason": "required input t1.prd",
  "trustLevel": "accepted",
  "included": true,
  "tokenEstimate": 42
}
```

这部分是项目亮点的可证明实现，不能只存在于文档描述。

## 9.9 P3 测试

新增：

```text
src/server/task-context/context-compiler.test.ts
src/server/task-context/context-policy.test.ts
src/server/task-context/qualification-filter.test.ts
src/server/task-context/relevance-ranker.test.ts
src/server/task-context/context-compressor.test.ts
src/server/task-context/context-externalizer.test.ts
src/server/task-context/context-packer.test.ts
src/server/task-context/context-budget.test.ts
src/server/task-context/context-renderer.test.ts
```

必须覆盖：

1. t3 只接收 dependsOn 声明的 t1/t2 输出。
2. 未验证输出不进入 `verified_inputs`。
3. 旁支输出被标记 `unrelated`。
4. active required Fact 进入 task context。
5. superseded/pending/rejected Fact 不注入。
6. required Fact 缺失时 task 不启动。
7. stale evidence 不注入。
8. mandatory context 不因预算被删除。
9. optional context 按优先级裁剪。
10. Snapshot 可以重放出同一 Prompt。
11. 同一输入和 policyVersion 生成等价 manifest。
12. XML 特殊字符不会破坏 Prompt 结构。
13. Hard Filter 对每个排除项产生稳定 reasonCode。
14. required/verified/Facts 的排序不会被普通 recency 覆盖。
15. Command 压缩后保留 exitCode、error excerpt 和 evidenceId。
16. Artifact 压缩后保留 id、version 和 verification。
17. Optional item 不能挤占 Mandatory budget。
18. Mandatory 超预算返回 `task_context_overflow`。
19. 30k 原始候选可以按 fixture 精简到目标预算，且 required 信息保留率为 100%。

## 9.10 P3 验收标准

- 每个 child run 都有 contextSnapshotId。
- 可以回答“这个 Agent 为什么看到了 art_xxx”。
- 可以回答“哪段上下文因预算被省略”。
- Snapshot 与实际发送 Prompt 一致。
- 可以区分“资格不通过”和“预算不足被省略”。
- 大对象只以摘要和受控引用进入 Prompt。

---

# P4：结构化 Acceptance Criteria 和 Verification Engine

## 10.1 目标

将自由文本验收升级为可执行的 Evidence Contract，并让系统输出逐条 criterion verdict。

## 10.2 Plan schema 修改

当前 `acceptanceCriteria` 是 `string[]`：

- `src/shared/types.ts:334`
- `src/server/tools/conductor-tools.ts:64-67`
- `src/server/tools/conductor-tools.ts:252`

目标类型：

```typescript
interface AcceptanceCriterionSpec {
  id: string;
  description: string;
  required: boolean;
  validator: CriterionValidator;
}
```

为兼容已有 Plan：

```typescript
type AcceptanceCriterionInput = string | AcceptanceCriterionSpec;
```

在 `parsePlanArgs()` / `compileAndValidateDispatchPlan()` 中将 string 归一化。

自由文本无法推断 validator 时：

- 默认 `reviewer_verdict`。
- 不得自动降级成字符串 includes。

## 10.3 Plan tool schema 修改

修改：

- `src/server/tools/conductor-tools.ts:64-94`
- 对应 Zod schema `:246-263`
- `src/server/dispatch-plan.ts:44-50`
- `src/components/dispatch-plan-editor.tsx:50`

Conductor 生成 Plan 时优先输出：

```json
{
  "id": "build-pass",
  "description": "生产构建成功",
  "required": true,
  "validator": {
    "type": "command_exit",
    "command": "pnpm build",
    "expectedExitCode": 0
  }
}
```

## 10.4 新增 Verification Engine

新建：

```text
src/server/verification/verification-engine.ts
src/server/verification/validator-registry.ts
src/server/verification/validators/file-validator.ts
src/server/verification/validators/command-validator.ts
src/server/verification/validators/artifact-validator.ts
src/server/verification/validators/deployment-validator.ts
src/server/verification/validators/user-confirmation-validator.ts
src/server/verification/validators/reviewer-validator.ts
```

签名：

```typescript
export async function verifyTaskAttempt(
  task: ParsedTask,
  attempt: TaskAttempt,
  report: DispatchTaskReport | undefined
): Promise<TaskVerificationResult>
```

返回：

```typescript
interface TaskVerificationResult {
  status: "verified" | "rejected" | "needs_review";
  verdicts: CriterionVerdict[];
  verifiedOutputBindings: Array<{
    outputKey: string;
    artifactId: string;
    evidenceIds: string[];
  }>;
  failureContext: FailureContext | null;
}
```

## 10.5 改造 `task-result-report.ts`

当前 `evaluateChildTaskResult()` 位于 `:19-139`。

改造原则：

1. 保留“是否调用 report_task_result”和 Agent 自报状态检查。
2. 删除机器可验证条件对 report.files/report.commands 的兜底信任。
3. 删除 `requiredEvidence` 的文本 `includes()`。
4. 调用 Verification Engine。
5. 返回全部 verdict，不只返回第一条 error。

目标：

```typescript
{
  status: "rejected",
  verdicts: [
    { criterionId: "file", status: "passed", evidenceIds: ["ev_1"] },
    { criterionId: "build", status: "failed", evidenceIds: ["ev_2"] }
  ],
  failureContext: ...
}
```

## 10.6 Output binding 改造

`persistOutputBinding()` 只能消费：

```typescript
verificationResult.verifiedOutputBindings
```

不能再直接消费：

```typescript
report.artifacts
```

Artifact validator 必须验证：

- Artifact 存在。
- conversationId 匹配。
- type 匹配。
- outputKey 匹配。
- `artifact_created` evidence 来自当前 attempt。
- Artifact version/contentHash 与 evidence 一致。

## 10.7 Reviewer 语义验收边界

无法用代码验证的视觉和语义标准可以使用 Reviewer Agent，但必须明确：

- Reviewer 只处理 `reviewer_verdict`。
- Reviewer 收到 verified input、产物和 criterion，不收到无关聊天。
- Reviewer verdict 本身记录为 evidence。
- Reviewer 不能覆盖命令失败、Artifact 缺失等确定性失败。

## 10.8 P4 测试

新增：

```text
src/server/verification/verification-engine.test.ts
src/server/verification/validator-registry.test.ts
src/server/verification/validators/*.test.ts
```

扩展：

- `src/server/task-result-report.test.ts`
- `src/server/tools/conductor-tools.test.ts`
- `src/server/dispatch-plan.test.ts`

必须覆盖：

1. Agent 声称测试通过但没有 command evidence，验收失败。
2. command exit 1 时，即使报告 passed 也失败。
3. 文件存在但不是当前 attempt 创建/修改，按 criterion 策略决定是否通过。
4. Artifact 来自其他 task 时不能绑定。
5. 所有 required criterion 通过才是 verified。
6. optional criterion 失败不阻塞，但进入 verdict。
7. Reviewer 不能覆盖确定性 validator 失败。

## 10.9 P4 验收标准

- 每个任务完成状态都能展开成逐条 verdict。
- 每条 passed verdict 都能定位 evidence ID。
- output binding 只来自 verified result。
- `report_task_result` 变成“候选报告”，不再是最终事实。

---

# P5：失败驱动的 Retry Context 和 Recovery Context

## 11.1 目标

让失败真正改变下一次上下文，而不是重复原 Prompt。

## 11.2 构建 FailureContext

修改或新增：

- `src/server/task-context/failure-context.ts`
- 统一后的 `src/server/conductor-service.ts`

来源：

- failed/missing criterion verdict。
- invalid/diagnostic evidence。
- command error excerpt。
- missing expected outputs。
- 本 attempt 已修改文件及 hash。
- 用户拒绝的审批。
- Tool error category。

生成示例：

```json
{
  "previousAttemptId": "ta_1",
  "failedCriteria": [
    {
      "criterionId": "build",
      "status": "failed",
      "reason": "pnpm build exited with 1",
      "evidenceIds": ["ev_cmd_1"]
    }
  ],
  "changedFiles": [
    {
      "path": "src/App.tsx",
      "contentHash": "sha256:...",
      "evidenceId": "ev_file_1"
    }
  ],
  "retryInstructions": [
    "修复 TypeScript error TS2322",
    "不要重新生成已通过验收的 PRD 和样式指南"
  ]
}
```

## 11.3 Retry 编译规则

attempt > 1 时：

必须保留：

- 原始 task objective。
- required inputs。
- acceptance criteria。
- 上一 attempt 失败 criterion。
- 失败命令摘要。
- 已修改文件。

不得重复：

- 已验证且未变化的上游 Artifact 全文。
- 无关历史消息。
- 上一 attempt 的完整 tool output。
- 已通过且不受影响的 criterion 过程。

## 11.4 Evidence 状态

失败 attempt 的 Evidence：

- 不删除。
- 文件写入和失败命令可用于 diagnosis。
- 不作为 accepted output 向下游传播。
- 若下一 attempt 修改同一文件，旧 hash 可标记 stale。

建议新增失效函数：

```typescript
markEvidenceStaleBySubject(subjectType, subjectId, supersedingEvidenceId)
```

## 11.5 Recovery Plan

当前 `src/server/orchestrator-service.ts:969` 附近已有失败 replan context。

改造：

- Recovery Plan 输入使用 `TaskVerificationResult[]`。
- 只把 verified task 标为可复用。
- rejected task 的输出不进入正常 binding。
- Recovery task 必须引用 failureContext 和缺失 output。
- 新 Plan revision 必须持久化，并记录 `resumedFromRunId`。

## 11.6 P5 测试

必须覆盖：

1. 第一次 build 失败，第二次 Context Snapshot 包含失败摘要。
2. 第二次不包含完整 stdout。
3. 第一次已通过的 criterion 不要求重复执行，除非相关文件已变化。
4. failed attempt Artifact 不传播。
5. retry 成功后新 verified Artifact 可以传播。
6. 服务重启后可从 SQLite 重建 FailureContext。

## 11.7 P5 验收标准

- 每次 retry 都能解释“上下文相比上一次变了什么”。
- retry 不依赖进程内变量。
- 已失败证据可诊断但不会污染下游事实。

---

# P6：证据驱动的跨 Agent 上下文传播

## 12.1 目标

将 DAG edge 从“等待关系”升级为带验证状态的 Context Channel。

## 12.2 输入解析规则

`resolveTaskInputs()` 当前只根据 output binding 找 artifactId。

改造 `src/server/child-prompt-builder.ts:35-51`：

```typescript
resolveVerifiedTaskInputs(task, planId)
```

每个 input 必须解析：

- producer task。
- producer verified attempt。
- output binding。
- Artifact。
- Artifact evidence。
- criterion verdict。

返回 `VerifiedTaskInput`。

任一 required input 缺失：

- 当前 task 不启动。
- 状态设为 `blocked_missing_verified_input`。
- 不让 Agent 自己猜测或重新生成上游内容。

## 12.3 Context Delta

每个 verified task 可以产生一个结构化 Context Delta：

```typescript
interface TaskContextDelta {
  taskId: string;
  verifiedAttemptId: string;
  acceptedDecisions: ContextFact[];
  artifactOutputs: VerifiedTaskInput[];
  workspaceChanges: Array<{
    path: string;
    contentHash: string;
    evidenceId: string;
  }>;
  resolvedConstraints: string[];
  remainingRisks: string[];
}
```

下游 Compiler 消费 Delta，而不是读取上游 Agent 的完整消息。

## 12.4 多 Agent 隔离规则

PM Agent 输出：

- PRD Artifact。
- 已确认需求。
- 验收标准。

UI Agent 只接收：

- 用户视觉约束。
- verified PRD。
- UI task evidence contract。

前端 Agent 只接收：

- verified PRD。
- verified style guide。
- target paths。
- build/test contract。

Reviewer 只接收：

- verified upstream requirements。
- implementation Artifact/workspace state。
- build/test evidence。
- review criteria。

任何 Agent 默认不接收其他 Agent 的：

- thinking。
- 完整工具日志。
- 无关任务消息。
- 未验证结论。

## 12.5 Aggregate 阶段

当前聚合 Prompt 位于：

- `src/server/orchestrator-service.ts:594-634`
- `src/server/orchestrator-service.ts:945-965`

改造：

1. Aggregate 只读取 verified task result 和 verdict。
2. 每个结论附 taskId、attemptId、evidenceIds。
3. failed/blocked 必须明确列出。
4. Artifact 引用只能来自 verified binding。
5. 不把普通 report.summary 当成最终事实。

## 12.6 P6 场景测试

建立 Todo App 四节点集成场景：

```text
t1 PM -> PRD
t2 UI -> Style Guide，依赖 t1.prd
t3 Frontend -> Web App，依赖 t1.prd + t2.style
t4 Reviewer -> Review，依赖 t3.app
```

验证：

1. t2 看不到 t3/t4 内容。
2. t3 只能收到 verified PRD/style。
3. t2 失败时 t3 不启动。
4. t3 build 失败时 t4 不启动。
5. t3 retry 成功后 t4 收到新 verified attempt，而不是失败 attempt。
6. Aggregate 只展示 verified Artifact。

## 12.7 P6 验收标准

- DAG 每条边都能显示其传输了什么 verified context。
- 无依赖旁支信息不会自动进入 Agent Prompt。
- 上游失败不会通过聊天文本绕过门禁。

---

# P7：API、SSE、Store 和前端可观测性

## 13.1 目标

用户不需要看到所有底层日志，但必须能查看：

- 当前任务拿到了哪些上下文。
- 上下文来自哪里。
- 哪些验收已经通过。
- 任务为什么失败。
- 输出为什么可以传播到下游。

## 13.2 StreamEvent 修改

当前 `src/shared/types.ts:354-455` 定义所有事件。

新增聚合事件：

```typescript
| {
    type: "dispatch.context.compiled";
    parentRunId: string;
    taskId: string;
    attemptId: string;
    contextSnapshotId: string;
    includedCount: number;
    omittedCount: number;
    tokenEstimate: number;
  }
| {
    type: "dispatch.verification.updated";
    parentRunId: string;
    taskId: string;
    attemptId: string;
    status: "checking" | "verified" | "rejected" | "needs_review";
    passedCount: number;
    failedCount: number;
  }
| {
    type: "dispatch.evidence.summary";
    parentRunId: string;
    taskId: string;
    attemptId: string;
    evidenceCount: number;
  }
```

不要通过 SSE 推送完整 evidence payload 或 Context Envelope，详细内容通过 API 按需读取。

## 13.3 Run 详情 API

当前 `src/app/api/runs/[id]/route.ts:52-64` 返回：

- run
- children
- orchestration
- compactionJobs

扩展：

```json
{
  "taskAttempts": [],
  "contextSnapshots": [],
  "evidenceSummary": [],
  "criterionVerdicts": []
}
```

列表接口只返回摘要，避免 response 过大。

新增：

```text
GET /api/task-attempts/:id
GET /api/task-attempts/:id/context
GET /api/task-attempts/:id/evidence
GET /api/task-attempts/:id/verdicts
```

文件：

```text
src/app/api/task-attempts/[id]/route.ts
src/app/api/task-attempts/[id]/context/route.ts
src/app/api/task-attempts/[id]/evidence/route.ts
src/app/api/task-attempts/[id]/verdicts/route.ts
```

安全要求：

- 不返回 secret。
- command output 只返回已清洗 excerpt。
- 文件内容不通过 evidence API 返回。
- 绝对 workspace path 转换为相对路径。

## 13.4 Store 修改

当前：

- `src/stores/store-types.ts`
- `src/stores/reducers/dispatch-events.ts:11-63`

扩展 `DispatchState`：

```typescript
attemptIdsByTask: Record<string, string[]>;
activeAttemptByTask: Record<string, string>;
verificationStatusByTask: Record<string, VerificationStatus>;
contextSnapshotByAttempt: Record<string, ContextSnapshotSummary>;
evidenceCountByAttempt: Record<string, number>;
verdictSummaryByAttempt: Record<string, VerdictSummary>;
```

Reducer 必须保持 selector snapshot 稳定，避免在 Zustand selector 中直接创建 `[]` 或 `{}` 导致 React `getSnapshot` 循环。

## 13.5 调度 UI

当前 `src/components/dispatch-progress.tsx:54-105` 是任务行。

修改为三层状态：

```text
执行：运行中 / 已报告 / 失败
验证：校验中 / 已验证 / 未通过
传播：可下游使用 / 已隔离
```

每个任务行增加：

- `上下文 8 项 · 3.2k tok`
- `证据 6 项`
- `验收 4/5`
- `第 2 次尝试`
- `已验证` 或 `未通过`

点击任务行打开详情，不要把所有信息直接堆在卡片上。

建议新增：

```text
src/components/task-evidence-drawer.tsx
src/components/task-context-manifest.tsx
src/components/criterion-verdict-list.tsx
src/components/task-attempt-timeline.tsx
```

### Context Manifest UI

显示：

- 类别。
- 来源。
- 为什么进入。
- trust level。
- token。
- 是否被省略。

### Evidence UI

按类型分组：

- 文件。
- 命令/测试。
- Artifact。
- 部署。
- 用户确认。

### Verdict UI

逐条显示：

- criterion。
- passed/failed/missing。
- 关联 evidence。
- 失败原因。

## 13.6 Plan Editor

当前 `src/components/dispatch-plan-editor.tsx:50` 只能编辑 string acceptance criteria。

升级：

- criterion description。
- validator type 下拉。
- path/command/outputKey 等条件字段。
- required 开关。
- 无法确定时选择“Reviewer 语义审查”。

不要要求普通用户填写 Evidence ID；Evidence ID 是运行时产生的。

## 13.7 P7 测试

新增/扩展：

- `src/stores/app-store.test.ts`
- `src/stores/reducers/dispatch-events.test.ts`
- `src/components/dispatch-progress.test.tsx`
- `src/components/dispatch-plan-editor.test.ts`
- 新 API route tests。

必须覆盖：

1. SSE 只传摘要，不泄露 evidence payload。
2. 刷新后 Run API 可以恢复 attempt/verdict。
3. UI 能区分“Agent 报告完成”和“系统验证完成”。
4. Context drawer 能解释 included/omitted。
5. selector 不产生无限更新。

## 13.8 P7 验收标准

- 用户能从任务卡片追溯到 Context、Evidence、Verdict。
- 页面刷新后诊断信息不丢失。
- UI 不展示敏感路径和密钥。

---

# P8：上下文检索、质量评估和发布验收

## 14.1 目标

在闭环正确后，再增加“相关历史召回”和系统级质量指标。不要在 P0-P4 之前先引入向量数据库。

## 14.2 SQLite FTS5 检索

优先使用 SQLite FTS5 索引：

- 用户消息。
- verified task summary。
- Artifact title/description。
- criterion verdict reason。
- file path。
- command/test name。

新建：

```text
src/server/task-context/context-retriever.ts
src/server/search/context-fts-index.ts
```

检索结果只能作为 `retrieved` trust level：

- 不能覆盖 authoritative constraint。
- 不能自动变成 verified fact。
- 必须带 sourceId。
- 默认只占 optional context budget。

## 14.3 Context Quality Metrics

新增指标：

```typescript
interface ContextQualityMetrics {
  totalTokens: number;
  requiredTokens: number;
  optionalTokens: number;
  omittedTokens: number;
  includedItemCount: number;
  staleItemRejectedCount: number;
  unverifiedItemRejectedCount: number;
  unrelatedItemRejectedCount: number;
  verifiedInputCount: number;
  retrievalHitCount: number;
}
```

运行质量指标：

- Context token 占模型窗口比例。
- 平均每个 task 的 Context item 数。
- Hard Filter 各 reasonCode 的剔除数量。
- 无关信息剔除率。
- 未验证输出拦截次数。
- superseded/pending Fact 泄漏次数，目标必须为 0。
- Mandatory 信息保留率，目标必须为 100%。
- 各 category 的压缩比。
- External Reference 被 Agent 按需重读的比例。
- retry 前后 Context 重复率。
- criterion 证据覆盖率。
- Agent 自报与系统 verdict 冲突率。
- 因 missing evidence 失败的任务比例。
- verified output 下游复用率。

## 14.4 离线评估集

新增：

```text
tests/fixtures/evidence-context/
scripts/evaluate-evidence-context.ts
```

至少包含：

1. 标准 Todo App 四角色协作。
2. 两个并行任务产生无关 Artifact。
3. Agent 虚报测试通过。
4. build 失败后 retry。
5. 上游 Artifact 被新版本替代。
6. 服务重启后恢复验证。
7. 超长会话下 Context budget 裁剪。
8. 用户修改需求导致旧约束 superseded。

每个 fixture 定义：

```json
{
  "expectedIncludedSources": [],
  "expectedOmittedSources": [],
  "expectedVerifiedOutputs": [],
  "expectedBlockedTasks": [],
  "expectedVerdicts": []
}
```

## 14.5 性能要求

本地单用户目标：

- Context Compiler 不调用 LLM 时，P95 < 100 ms。
- Evidence insert P95 < 20 ms。
- Task detail API P95 < 200 ms。
- 单个 attempt evidence 默认分页 50 条。
- Context Snapshot payload 建议限制 256 KB。
- Evidence payload 建议限制 32 KB，超出保存 hash + excerpt。

## 14.6 发布前测试

必须执行：

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

额外执行：

- Evidence Context fixture evaluator。
- SQLite 老数据库升级测试。
- 服务重启恢复测试。
- DeepSeek 实际端到端 smoke test。

## 14.7 P8 验收标准

- Context selection 有可重复评估集。
- 项目可以量化“减少了多少无关上下文”和“拦截了多少未验证输出”。
- 性能不会因为 Evidence Ledger 和 Snapshot 明显劣化。

---

## 15. 文件级修改总表

| 文件 | 当前锚点 | 主要修改 | 优先级 |
|---|---|---|---|
| `src/server/agent-runner.ts` | `StartRunInput`、`AdapterInput` 构建 | 贯穿 task identity，统一 Conductor 入口 | P0 |
| `src/server/adapters/types.ts` | `AdapterInput` | 增加 taskExecution/contextSnapshot | P0 |
| `src/server/adapters/custom-agent-adapter.ts` | `ToolContext` 构建 | 传递 task identity | P0 |
| `src/server/tools/types.ts` | `ToolContext` | 增加 taskExecution | P0 |
| `src/server/conductor-service.ts` | fact extraction/child dispatch/retry/output binding | Fact 提取、Context 编译、attempt、验证门禁、传播 | P0-P6 |
| `src/server/orchestrator-service.ts` | 当前活动旧入口 | 合并后退出活动链路 | P0 |
| `src/server/tools/conductor-tools.ts` | Plan schema/ParsedTask | Fact requirements、结构化 criterion/evidence contract | P0/P2/P4 |
| `src/server/tools/orchestrator-tools.ts` | 当前活动旧工具 | 合并后退出活动链路 | P0 |
| `src/shared/types.ts` | `DispatchPlanItem`、`StreamEvent` | criterion 类型、Evidence 事件摘要 | P4/P7 |
| `src/shared/ids.ts` | ID helpers | attempt/context/evidence/verdict/fact ID | P0/P2 |
| `src/shared/evidence-types.ts` | 新文件 | Evidence 数据契约 | P0 |
| `src/shared/task-context-types.ts` | 新文件 | Envelope/Manifest/Failure/Fact 类型 | P0/P2/P3/P5 |
| `src/shared/builtin-fact-definitions.ts` | 新文件 | 只读基础 Fact Definition | P2 |
| `src/shared/context-fact-types.ts` | 新文件 | Definition/Candidate/Fact/Resolution 类型 | P2 |
| `src/server/context-facts/*` | 新目录 | Registry、Canonicalizer、版本更新和 Conductor 提取 | P2 |
| `src/server/tools/update-context-facts.ts` | 新工具 | 受约束提交 Fact 更新和新 Definition 提案 | P2 |
| `src/server/child-prompt-builder.ts` | `buildChildTaskPrompt` | 只保留 renderer，消费 Envelope | P3 |
| `src/server/task-result-report.ts` | `evaluateChildTaskResult` | 移除自报兜底，接 Verification Engine | P4 |
| `src/server/dispatch-tool-evidence.ts` | 全局 Map | 改为持久化 facade | P1 |
| `src/server/tools/registry.ts` | `execute()` | 统一 Evidence Collector，注册 Fact Tool | P1/P2 |
| `src/server/tools/read-evidence.ts` | 新工具 | 按权限读取外置 Evidence 详情 | P1/P3 |
| `src/server/tools/fs-write.ts` | 写入完成 | 文件 hash evidence | P1 |
| `src/server/tools/bash.ts` | 命令完成 | command/test evidence | P1 |
| `src/server/tools/write-artifact.ts` | Artifact 创建 | artifact evidence | P1 |
| `src/server/tools/deploy-workspace.ts` | 部署完成 | deployment evidence | P1 |
| `src/server/tools/deploy-artifact.ts` | 部署完成 | deployment evidence | P1 |
| `src/db/schema.ts` | orchestration/context tables | Evidence 四表 + Conversation Fact 三表 | P1/P2 |
| `src/db/bootstrap.ts` | raw SQL bootstrap | 新表、索引、兼容升级 | P1/P2 |
| `src/server/repositories.ts` | orchestration repository | attempt/evidence/snapshot/verdict/fact repository | P1/P2 |
| `src/server/task-context/*` | 新目录 | Context Compiler 全链路 | P3/P5/P8 |
| `src/server/evidence/*` | 新目录 | Collector/extractor/sanitizer/hash | P1 |
| `src/server/verification/*` | 新目录 | Validator registry 和 engine | P4 |
| `src/app/api/runs/[id]/route.ts` | Run detail | 返回 attempt/context/evidence/verdict 摘要 | P7 |
| `src/app/api/task-attempts/*` | 新 API | 详情查询 | P7 |
| `src/app/api/conversations/[id]/facts/*` | 新 API | active Fact、历史和 pending proposal | P2/P7 |
| `src/stores/store-types.ts` | `DispatchState` | attempt/verification/context 摘要 | P7 |
| `src/stores/reducers/dispatch-events.ts` | dispatch event reducer | 应用新事件 | P7 |
| `src/components/dispatch-progress.tsx` | `DispatchTaskRow` | 三层状态和详情入口 | P7 |
| `src/components/context-fact-panel.tsx` | 新组件 | Active Fact、版本和 pending proposal | P2/P7 |
| `src/components/dispatch-plan-editor.tsx` | acceptance editor | 结构化 validator 编辑 | P4/P7 |

---

## 16. 建议提交顺序

为了降低单次改动风险，建议按以下 commit 拆分：

```text
refactor(conductor): establish one canonical runtime path
feat(runtime): propagate task execution identity into tool context
fix(conductor): block unverified output bindings and unrelated artifacts
feat(db): add task attempts context snapshots evidence and verdicts
feat(evidence): persist tool evidence through centralized collector
feat(facts): add conversation-scoped fact registry and versioned values
feat(facts): canonicalize conductor fact candidates through runtime policy
feat(context): compile immutable evidence-aware task context snapshots
feat(verification): validate task criteria against persisted evidence
feat(retry): build failure-aware incremental retry context
feat(dispatch): route only verified task outputs through DAG edges
feat(api): expose task context evidence and verdict diagnostics
feat(ui): show context manifest evidence and verification status
test(context): add evidence-aware multi-agent integration fixtures
```

每个 commit 都必须独立通过 typecheck 和相关测试。

---

## 17. 完整端到端示例

用户请求：

```text
帮我做一个 Todo List Web App，使用 React，不需要登录，主色用绿色。
```

Conductor 先进入 `extracting_facts`：

```text
technical.frontend.framework = React
feature.auth.required = false
ui.theme.primaryColor = green
```

其中三个字段都匹配代码内置 Definition，因此 Runtime 直接创建 conversation active Facts。

如果用户还补充：

```text
每个任务可以设置一个最多 30 分钟的专注时长。
```

而注册表中没有对应 Definition，则 Conductor 提交：

```json
{
  "entity": "todo_task",
  "property": "focus_duration_limit",
  "value": 30,
  "valueType": "number",
  "description": "单个任务允许设置的最大专注时长，单位分钟"
}
```

Runtime 创建当前 conversation 的动态 Definition：

```text
todo.task.focusDurationLimitMinutes
```

随后再进入 Planning。

Conductor Plan：

```text
t1 PM：生成 PRD
t2 UI：生成 Style Guide，dependsOn=[t1]
t3 Frontend：实现应用，dependsOn=[t1,t2]
t4 Reviewer：验收，dependsOn=[t3]
```

### t1 Context

注入：

- 用户原始需求。
- `project.goal`、`technical.frontend.framework`、`feature.auth.required` 等 planning 相关 active Facts。
- PRD expected output。
- Artifact creation criterion。

不注入：

- 空 Workspace 全量文件树。
- 未来 UI/Frontend task 内容。

t1 完成后：

- `write_artifact` 产生 `ev_prd_created`。
- Artifact validator 检查 type=document、outputKey=prd。
- t1 进入 `verified_complete`。
- `t1.prd -> art_prd` binding 生效。

### t2 Context

注入：

- `ui.theme.primaryColor=green` 等 UI namespace active Facts。
- `art_prd` metadata 和 verification reference。
- Style Guide 验收标准。

不注入：

- t1 的 thinking/tool log。
- 与 PRD 无关的群聊。

t2 失败时：

- Style Artifact 不绑定。
- t3 因缺少 `t2.style` 保持 blocked。

### t3 Context

注入：

- `technical.frontend.framework=React`。
- `feature.auth.required=false`。
- `ui.theme.primaryColor=green`。
- `todo.task.focusDurationLimitMinutes=30`。
- verified PRD。
- verified Style Guide。
- target paths。
- required command `pnpm build`。
- expected web_app/deployment。

第一次 attempt：

- 写入 `src/App.tsx` -> file evidence。
- `pnpm build` exit 1 -> failed command evidence。
- Verification 判定 build criterion failed。

第二次 Context：

- 保留 PRD/style refs。
- 加入 build error excerpt 和 evidenceId。
- 加入已修改文件 hash。
- 不重复 t1/t2 的完整历史。

第二次 build exit 0：

- build criterion passed。
- deployment evidence passed。
- t3 output binding 生效。

### t4 Context

只接收：

- t3 verified app/deployment。
- PRD/style 中与 review criteria 相关的约束。
- build evidence。
- Reviewer criterion。

最终 Aggregate：

- 引用 verified Artifact。
- 展示每个 task 的 verified/rejected 状态。
- 不把 failed attempt 当成最终交付。

---

## 18. 最终 Definition of Done

Evidence-aware Context Engineering 只有同时满足以下条件，才算完成：

### 事实注册表

- 代码内置 Definition 与 conversation 动态 Definition 可以统一查询。
- Agent 正常路径只选择 definitionId 和填写 value，不直接裁定 canonical key。
- Runtime 能处理 Definition、Alias、entity/property 和新 Definition proposal。
- replace Fact 形成 active/superseded 版本链。
- pending、rejected、superseded Fact 不进入正常任务上下文。
- Fact 能追溯到用户消息、用户回答或 verified Evidence。
- 动态 Definition 和 Fact 严格按 conversation 隔离。

### 数据与身份

- 每个 child run 属于明确 plan/task/attempt。
- 每个 attempt 有不可变 Context Snapshot。
- 每条 Evidence 可追溯到 attempt 和 tool/user event。
- 服务重启后数据仍可恢复。

### 上下文选择

- Context 由 Compiler 构建，不由 service 临时拼接。
- DAG 直接依赖决定默认输入传播。
- verified/unverified/stale 状态参与选择。
- Token 裁剪有 manifest。

### 证据与验收

- 机器可验证项目不信任 Agent 自述。
- 每条 passed criterion 有 evidence。
- failed task output 不进入 binding。
- required input 未验证时下游不启动。

### 重试与恢复

- retry 使用新 Context Snapshot。
- FailureContext 包含 criterion/evidence/command/file 增量。
- failed attempt evidence 保留但隔离。
- 服务重启后能重建 retry context。

### 可观测性

- UI 能显示 Context、Evidence、Verdict。
- Run API 能查询完整闭环。
- 不泄露 secret、完整日志或敏感绝对路径。

### 质量

- 单元、集成、迁移和端到端测试通过。
- Todo App 四 Agent 场景通过。
- 有可量化的上下文剔除率、证据覆盖率和未验证输出拦截指标。

---

## 19. 对外项目亮点表述

完成 P0-P6 后，可以在 README、简历和面试中使用：

> **证据上下文：** 设计 Evidence-aware Context Engineering 机制，将任务 DAG 同时作为执行图和上下文路由图；Runtime 根据当前任务、已验证上游产物、工具执行证据、失败原因和验收标准动态编译最小任务上下文，并通过“Agent 报告—证据校验—结果验证—下游传播”门禁，避免未验证结论和无关群聊污染跨 Agent 协作。

更偏架构的表述：

> AgentMeld 不依赖多个 Agent 自由聊天传递状态，而是为每个 task attempt 生成可版本化的 Context Snapshot 和 Evidence Manifest。文件、命令、Artifact、部署及用户确认由 Runtime 自动记录为 Evidence Ledger，任务输出只有通过逐条 Acceptance Criterion 校验后才会绑定到 DAG，并作为 verified context 传递给下游 Agent。
