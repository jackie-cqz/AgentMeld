# AgentMeld Collaboration Benchmark 优先级实施计划

> 文档状态：Draft
> 适用基线：AgentMeld release2.0 / release3.0 当前代码
> 目标：建立一套面向多 Agent 协作、证据驱动上下文和工具执行闭环的可重复 Benchmark，而不是复用以终端操作能力为主的通用 Coding Agent 排行榜。

## 1. 背景与结论

AgentMeld 的核心能力不是让单个 Agent 在终端中独立完成一道题，而是让 Conductor、PM、UI 设计师、前端工程师和 Reviewer 围绕同一个目标完成角色化协作：

```text
用户需求
  -> Conductor 澄清与任务拆分
  -> DAG 依赖调度
  -> PM / UI / Frontend / Reviewer 分工
  -> verified output binding 传播
  -> Evidence-aware Context 编译
  -> 工具执行与审批
  -> Artifact / Deployment
  -> Verification Gate
  -> 最终结果聚合
```

Terminal-Bench 2.x 主要评估 Agent 在容器化终端环境中完成编译、系统配置、服务部署等任务的能力，其任务集和最终测试脚本很适合测试单 Agent 的终端能力，但不能直接回答以下 AgentMeld 特有问题：

- Conductor 是否生成了有效 DAG。
- UI Agent 是否真正拿到了 PM 的 PRD。
- Frontend Agent 是否读取了 PRD 和风格指南。
- 过期事实是否被 Fact Registry 拒绝。
- 未验证的 Artifact 或 Deployment 声明是否被拦截。
- 失败任务是否只重试必要节点，而不是重跑全部流程。
- 相同模型下，Evidence-aware Context 是否优于完整历史或普通摘要。

因此本项目应建设 `AgentMeld Collaboration Benchmark` 作为主评测体系，同时只把 Terminal-Bench 的隔离环境、可执行验收、轨迹保存和任务质量校验方法作为参考。Terminal-Bench 可在后续作为前端工程师或工具执行层的辅助能力测试，不作为 AgentMeld 的核心质量分数。

参考资料：

- [Terminal-Bench / Harbor 官方运行说明](https://www.harborframework.com/docs/tutorials/running-terminal-bench)
- [Terminal-Bench 2.1 持续验证说明](https://www.tbench.ai/news/terminal-bench-2-1)
- [Anthropic：Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

## 2. 当前代码基线

### 2.1 已有能力

当前仓库已经具备 Evaluation Harness MVP：

- `tests/e2e-fixtures/` 中已有 6 个固定任务。
- `tests/e2e-runner/evaluate-run.ts` 可以按 `runId + fixture` 评估已有运行。
- `tests/e2e-runner/benchmark.ts` 可以读取 fixtures、评估已有 run、生成汇总并比较两个 run。
- `src/server/context-trace/` 可以追溯 task attempt、输入、输出绑定和 Evidence。
- `src/server/context-metrics/` 已有上下文指标、fixture report 和 quality gates。
- `src/server/context-metrics/benchmark-types.ts` 已定义 Benchmark Case、Metrics 和 Report 基础类型。
- `package.json` 已提供 `e2e:fixture`、`agent:bench`、`agent:bench:all` 和 `quality:gates` 命令。

现有任务覆盖：

```text
todo-list
pomodoro-timer
markdown-editor
personal-blog
expense-tracker
fix-broken-app
```

### 2.2 当前关键缺口

#### 2.2.1 Runner 不能自动发起完整运行

当前 Benchmark 主要接收人工提供的 `runId`，还不能完整执行：

```text
创建隔离数据目录
-> 启动/连接 AgentMeld
-> 创建会话
-> 发送 fixture prompt
-> 自动处理 ask_user
-> 等待 Conductor 结束
-> 收集运行证据
-> 执行 grader
-> 保存报告
```

所以当前更像“历史 run 评分器”，而不是一键可重复运行的 Benchmark Harness。

#### 2.2.2 验收条件仍是自然语言字符串

现有 fixture 使用：

```json
{
  "successCriteria": [
    "Frontend reads PRD and style guide",
    "Frontend runs build successfully"
  ]
}
```

当前 evaluator 会根据字符串是否包含 `read`、`build`、`deploy` 等关键词推断如何评分。这会产生误判，也无法准确定位到具体角色、task、outputKey、artifactId 或 tool call。

#### 2.2.3 部分 Metrics 是近似值或固定值

以下指标还没有全部从真实数据计算：

- `contextOmissionRate`
- `staleFactRejectedCount`
- `approvalRequestCount`
- `jsonRepairCount`
- `estimatedInputTokens`
- `reviewerPassed`
- 精确的 `expectedRoleCoverage`
- 精确的 `expectedOutputCoverage`

#### 2.2.4 缺少重复采样和统计口径

单次成功不能说明 Agent 稳定。当前缺少：

- `repeat / trials`。
- 同一 Case 多次运行。
- Pass@1、平均成功率、全成功率。
- P50 / P95 耗时。
- 均值、标准差和置信区间。
- 失败类型分布。

#### 2.2.5 缺少环境隔离和实验元数据

不同运行可能共享数据库、Workspace、历史 Artifact 或事实状态，造成污染。当前报告也没有稳定记录：

- Git commit。
- 模型和 API Provider。
- Prompt 版本或哈希。
- Agent 配置和工具权限。
- Context Strategy。
- 操作系统和 Node 版本。
- Token / 时间 / 工具调用预算。

#### 2.2.6 缺少可执行的产物质量评分

目前主要判断 Artifact 和 Deployment 是否存在，还没有系统验证：

- 页面是否能真正打开。
- 浏览器控制台是否报错。
- Todo 是否能添加、编辑、完成和删除。
- Pomodoro 是否能开始、暂停和重置。
- 构建产物是否缺少静态资源。
- PRD、风格指南和 Reviewer 报告是否满足质量 Rubric。

## 3. Benchmark 的目标与非目标

### 3.1 目标

1. 可重复运行一组真实的多 Agent 协作任务。
2. 用数据库状态、工具事件、Evidence、Artifact 和浏览器行为进行确定性验收。
3. 量化 Evidence-aware Context 对成功率、上下文交接、过期事实控制和 Token 成本的影响。
4. 对 Prompt、工具策略、Context Strategy、模型和代码版本做可比较的回归测试。
5. 失败时能定位到 `runId -> taskId -> attemptId -> assertion -> evidenceId`。
6. 将结果保存为机器可读 JSON 和适合人工审查的 Markdown 报告。

### 3.2 非目标

- 第一阶段不做公开排行榜。
- 第一阶段不追求上百个任务。
- 不用 LLM Judge 代替可由代码确定的事实。
- 不要求 Conductor 生成唯一固定 DAG，只验证必要依赖和协作不变量。
- 不把页面“视觉好看”作为唯一结果指标。
- 不要求第一阶段接入 Docker 或 Harbor。
- 不把 Benchmark 结果直接作为模型能力排行榜。

## 4. 总体架构

```text
Benchmark Suite
  ├─ Case Definitions
  ├─ Environment Setup
  ├─ User Simulator
  ├─ Run Driver
  ├─ Trace Collector
  ├─ Grader Registry
  │   ├─ Runtime Grader
  │   ├─ Context Grader
  │   ├─ Evidence Grader
  │   ├─ Artifact Grader
  │   ├─ Browser Grader
  │   └─ Optional LLM Judge
  ├─ Metrics Aggregator
  ├─ Trial Statistics
  └─ JSON / Markdown Report
```

建议目录：

```text
tests/agent-benchmark/
  cases/
    collaboration/
    context-handoff/
    fact-update/
    recovery/
    safety/
    false-completion/
  graders/
    role-grader.ts
    dag-grader.ts
    context-grader.ts
    evidence-grader.ts
    artifact-grader.ts
    deployment-grader.ts
    browser-grader.ts
    rubric-grader.ts
  runtime/
    benchmark-runner.ts
    environment-manager.ts
    conversation-driver.ts
    user-simulator.ts
    run-waiter.ts
    trace-collector.ts
  reporting/
    metrics-aggregator.ts
    statistics.ts
    json-reporter.ts
    markdown-reporter.ts
    comparison-reporter.ts
  schemas/
    benchmark-case.ts
    assertion.ts
    report.ts
  benchmark-cli.ts
```

## 5. 核心数据结构

### 5.1 Case 定义

建议把自然语言 `successCriteria` 替换为结构化 assertions：

```ts
export interface AgentBenchmarkCase {
  schemaVersion: 1;
  id: string;
  title: string;
  category:
    | "collaboration"
    | "context_handoff"
    | "fact_update"
    | "recovery"
    | "safety"
    | "false_completion";

  prompt: string;
  userScript?: UserScriptStep[];
  workspaceFixture?: string;

  expectedRoles?: string[];
  requiredTaskEdges?: RequiredTaskEdge[];
  assertions: BenchmarkAssertion[];

  limits: {
    maxDurationMs: number;
    maxModelCalls?: number;
    maxToolCalls?: number;
    maxInputTokens?: number;
    maxAttemptsPerTask?: number;
  };

  tags: string[];
}
```

### 5.2 User Simulator

用于自动回答 `ask_user`、审批和依赖安装请求：

```ts
export type UserScriptStep =
  | {
      when: "ask_user";
      questionMatches: string;
      answer: string | string[];
    }
  | {
      when: "bash_approval";
      commandMatches: string;
      decision: "approve" | "reject";
    }
  | {
      when: "timeout";
      afterMs: number;
      action: "abort";
    };
```

### 5.3 Assertion 类型

```ts
export type BenchmarkAssertion =
  | RoleExecutedAssertion
  | DagEdgeAssertion
  | OutputBindingAssertion
  | ArtifactReadAssertion
  | ToolSucceededAssertion
  | ToolBlockedAssertion
  | FactStateAssertion
  | ContextContainsAssertion
  | ContextExcludesAssertion
  | DeploymentReadyAssertion
  | PreviewHttpAssertion
  | BrowserInteractionAssertion
  | RetryBoundAssertion
  | NoFalseCompletionAssertion
  | RubricAssertion;
```

示例：

```json
{
  "type": "artifact_read",
  "id": "frontend-read-prd",
  "consumerRole": "frontend",
  "producerRole": "pm",
  "outputKey": "prd",
  "required": true,
  "weight": 1
}
```

```json
{
  "type": "fact_state",
  "id": "latest-primary-color-active",
  "factKey": "ui.theme.primary_color",
  "expectedValue": "blue",
  "expectedStatus": "active",
  "forbidActiveValues": ["red"],
  "required": true,
  "weight": 2
}
```

### 5.4 Assertion Result

```ts
export interface AssertionResult {
  assertionId: string;
  type: BenchmarkAssertion["type"];
  status: "passed" | "failed" | "blocked" | "not_applicable";
  score: number;
  maxScore: number;
  reason: string;
  references: Array<{
    runId?: string;
    taskId?: string;
    attemptId?: string;
    contextSnapshotId?: string;
    evidenceId?: string;
    artifactId?: string;
    toolCallId?: string;
  }>;
}
```

## 6. Grader 分层

### 6.1 确定性 Runtime Grader

从 SQLite、Context Trace 和运行事件判断：

- 必需角色是否执行。
- DAG 是否无环。
- 必需依赖边是否存在。
- task attempt 是否在预算内。
- execution / verification status 是否正确。
- run 是否结束，还是卡在 pending / approval。

### 6.2 Context Grader

验证 Evidence-aware Context：

- required upstream input 是否进入 Context Snapshot。
- Artifact 是否通过 verified output binding 传播。
- 下游是否实际调用 `read_artifact`。
- superseded Fact 是否被排除。
- active Fact 是否进入正确角色的上下文。
- private agent trace 是否没有泄漏到不相关 Agent。
- 上下文是否超过预算。
- omitted manifest 是否给出明确原因。

### 6.3 Evidence Grader

验证任务完成不是 Agent 自报：

- `write_artifact` 是否存在成功工具事件。
- `deploy_workspace` 是否存在成功工具事件。
- output binding 是否指向真实 Artifact。
- Artifact type 是否匹配 task contract。
- required output 缺失时是否判失败。
- 手写 artifactId、deployment path 是否被 Verification Gate 拦截。

### 6.4 Artifact / Workspace Grader

验证文件和产物：

- 必需文件存在。
- JSON、Markdown、HTML 等格式可解析。
- 构建命令退出码为 0。
- 构建产物目录存在。
- Artifact 版本和 Deployment 指向同一有效内容。
- Workspace 未发生越界写入。

### 6.5 Browser Grader

Web App Case 使用 Playwright 或等价浏览器测试：

- Preview URL 返回 200。
- 页面不是空白页。
- 控制台没有未处理异常。
- 静态资源加载成功。
- 关键元素存在。
- 核心交互可完成。

例如 Pomodoro Case：

```text
打开预览
-> 查找计时显示
-> 点击开始
-> 确认状态改变
-> 点击暂停
-> 点击重置
-> 确认恢复初始值
```

### 6.6 Optional LLM Judge

仅用于难以完全确定性判断的质量问题：

- PRD 是否明确覆盖用户需求。
- 风格指南是否具备可执行参数。
- Reviewer 是否基于证据指出问题。
- 最终自然语言总结是否与真实结果一致。

约束：

- LLM Judge 不能判断 Deployment 是否成功。
- LLM Judge 不能判断 Artifact 是否被读取。
- LLM Judge 不能覆盖确定性 Grader 的失败。
- Judge Rubric 必须版本化。
- 需要准备少量人工标注样本，检查 Judge 与人工判断的一致性。

## 7. 统一指标体系

### 7.1 结果指标

- `caseSuccessRate`
- `requiredAssertionPassRate`
- `artifactCompletionRate`
- `deploymentReadyRate`
- `browserInteractionPassRate`
- `reviewerPassRate`

### 7.2 协作指标

- `planValidRate`
- `requiredRoleCoverage`
- `requiredDagEdgeCoverage`
- `taskSkipRate`
- `retryRate`
- `maxAttemptViolationCount`

### 7.3 上下文指标

- `verifiedInputCoverage`
- `upstreamArtifactReadRate`
- `requiredContextRecall`
- `contextPrecision`
- `contextOmissionRate`
- `staleFactLeakageRate`
- `privateContextLeakageCount`
- `contextBudgetViolationCount`

其中：

```text
requiredContextRecall
= 被正确包含的必需上下文项 / Case 定义的必需上下文项

contextPrecision
= 被判定为相关的已包含项 / 全部已包含项

staleFactLeakageRate
= 错误进入下游上下文的 superseded facts / 可检查的 superseded facts
```

### 7.4 工具与证据指标

- `toolFailureRate`
- `jsonRepairRate`
- `approvalRequestCount`
- `falseCompletionBlockedRate`
- `unverifiedOutputBlockedRate`
- `requiredEvidenceCoverage`

### 7.5 成本与稳定性指标

- `passAt1`
- `trialSuccessRate`
- `allTrialsPassRate`
- `averageAttempts`
- `averageModelCalls`
- `averageToolCalls`
- `averageInputTokens`
- `averageOutputTokens`
- `p50DurationMs`
- `p95DurationMs`
- `estimatedCost`

不应只使用 `pass@k`。对于产品可靠性，“5 次中任意 1 次成功”会掩盖不稳定，应同时报告：

```text
Pass@1
N 次平均成功率
N 次全部成功率
失败类型分布
```

## 8. Benchmark Case 规划

首个完整版本建议 24 个 Case。第一阶段可以先做 10 个高质量 Case。

### 8.1 基础协作类：6 个

| Case | 重点验证 |
|---|---|
| `todo-list-basic` | PM -> UI -> Frontend -> Reviewer 完整链路 |
| `pomodoro-timer-basic` | 需求澄清、定时逻辑、部署预览 |
| `markdown-editor-basic` | 多区域 UI、状态同步、样式交接 |
| `expense-tracker-basic` | 表单、列表、统计、状态管理 |
| `personal-blog-static` | 静态优先策略、页面部署 |
| `dashboard-basic` | 多组件布局、数据展示、Reviewer 验收 |

### 8.2 上下文交接类：5 个

| Case | 重点验证 |
|---|---|
| `ui-must-read-prd` | UI 收到并读取 PM Artifact |
| `frontend-must-read-upstream` | Frontend 读取 PRD 与风格指南 |
| `reviewer-must-read-web-app` | Reviewer 读取部署产物 |
| `verified-binding-only` | 未验证输出不进入下游 |
| `private-trace-isolation` | Agent 私有执行信息不泄漏 |

### 8.3 Fact 更新类：4 个

| Case | 重点验证 |
|---|---|
| `primary-color-superseded` | 红色修改为蓝色后只使用蓝色 |
| `framework-choice-updated` | React 修改为纯 HTML 后旧技术栈失效 |
| `deadline-corrected` | 截止时间更正后旧时间不再传播 |
| `scope-reduced` | 用户删除某项功能后下游不再实现 |

### 8.4 故障恢复类：4 个

| Case | 重点验证 |
|---|---|
| `artifact-json-repair` | write_artifact 参数损坏后的修复 |
| `frontend-build-retry` | build 失败后带 FailureContext 重试 |
| `deployment-path-recovery` | 构建目录识别失败后的恢复 |
| `child-run-interrupted` | 子 Agent 中断后的 attempt 恢复 |

### 8.5 安全策略类：3 个

| Case | 重点验证 |
|---|---|
| `workspace-path-traversal` | 越界写入被拦截 |
| `bash-source-mutation-blocked` | Bash 修改源码被拦截，Agent 改用 fs_patch |
| `dependency-install-approval` | 安装依赖进入审批且可恢复执行 |

### 8.6 虚假完成类：2 个

| Case | 重点验证 |
|---|---|
| `fake-artifact-id` | 手写 Artifact ID 被拒绝 |
| `fake-deployment-url` | 无 deploy 工具证据的部署声明被拒绝 |

## 9. 优先级实施计划

### 9.1 P0：结构化 Case Schema 与确定性 Assertion Engine

> 实施状态：已完成（2026-07-13）。统一 Case/Assertion 契约、7 类确定性 Grader、6 个 fixture 迁移、run-level Evidence 聚合及 CLI/测试入口均已落地；TypeScript、定向测试和全量 Vitest 已通过。

#### 目标

消除自然语言关键词评分，为所有后续 Benchmark 能力建立稳定契约。

#### 修改位置

- 重构 `tests/e2e-runner/types.ts`。
- 重构 `src/server/context-metrics/benchmark-types.ts`，避免形成两套互不兼容的类型。
- 新增 `tests/agent-benchmark/schemas/benchmark-case.ts`。
- 新增 `tests/agent-benchmark/schemas/assertion.ts`。
- 新增 `tests/agent-benchmark/graders/grader-registry.ts`。
- 新增基础 Grader：role、DAG、binding、artifact read、tool、deployment。
- 将 `tests/e2e-fixtures/*.json` 迁移到新 schema，或者提供一次性兼容转换器。
- 新增 Case schema validation 测试。

#### 实现要求

1. 每条 Assertion 必须有稳定 `id`。
2. `required: true` 的 Assertion 失败时，Case 不得通过。
3. 每个结果必须携带可追踪引用。
4. 不允许根据自然语言关键词选择评分逻辑。
5. Case 文件加载时必须执行 schema 校验。
6. Schema 增加 `schemaVersion`，为后续升级保留迁移能力。

#### 验收标准

- 6 个现有 fixtures 全部迁移或可通过兼容层加载。
- 删除 `includes("read")`、`includes("build")` 一类评分分支。
- 修改某条自然语言描述不会改变 Assertion 评分。
- Assertion 失败能指向 taskId、attemptId 或 evidenceId。
- Schema 错误在运行开始前失败，而不是跑完后才报错。

### 9.2 P1：自动 Run Driver 与隔离环境

> 实施状态：已完成（2026-07-13）。已落地独立 trial 数据目录、自动会话与 Agent 组创建、Prompt 驱动、事件总线与数据库双通道等待、`ask_user`/审批脚本模拟、超时 abort、trace/report 兜底落盘及自动 CLI；TypeScript、专项测试、全量 Vitest 和 Next.js 生产构建均已通过。

#### 实施结果

- `environment-manager.ts` 为每个 trial 创建唯一 `AGENTMELD_DATA_DIR`，数据库、Workspace、Fact 与 Artifact 不跨 trial 复用。
- `conversation-driver.ts` 根据 `expectedRoles` 解析内置 Agent，自动创建群聊、Workspace，并发送 Case Prompt；返回 conversation、Conductor run 和 Workspace 身份。
- `user-simulator.ts` 在发送 Prompt 前订阅事件，支持按 Case 脚本回答 `ask_user`，以及批准或拒绝 dispatch plan、文件写入和依赖安装命令。
- `run-waiter.ts` 同时监听 `run.end` 与轮询数据库终态；超时后级联 abort，并保留短暂收敛窗口，避免关闭仍在使用的 SQLite。
- `trace-collector.ts` 归档当前 trial 的事件、runs、task attempt IDs 和可用的 run-level Context Trace。
- `benchmark-runner.ts` 对 passed、failed、异常和 timeout 使用同一 finally 收口，无论评分是否可用都尝试写出 `trace.json` 与 `report.json`。
- CLI 新增 `--case`、`--suite`、`--repeat`、`--output-dir`，原 `--run` 保留为已有 run 的重评分入口。
- P1 验收由 runtime/schema 测试覆盖，包括跨 trial 数据隔离、自动问答、审批决策、事件丢失后的轮询、超时 abort、ID 关联和失败报告兜底。

#### 目标

让 Benchmark 能自动发起 AgentMeld 任务，而不是依赖人工提供 runId。

#### 修改位置

- 新增 `tests/agent-benchmark/runtime/benchmark-runner.ts`。
- 新增 `tests/agent-benchmark/runtime/environment-manager.ts`。
- 新增 `tests/agent-benchmark/runtime/conversation-driver.ts`。
- 新增 `tests/agent-benchmark/runtime/run-waiter.ts`。
- 新增 `tests/agent-benchmark/runtime/user-simulator.ts`。
- 新增 `tests/agent-benchmark/runtime/trace-collector.ts`。
- 视现有 API 能力补充专用测试 API，或直接复用 conversation service。
- 更新 `package.json` benchmark scripts。

#### 实现要求

1. 每个 trial 使用独立数据库和 Workspace。
2. 自动创建会话和 Agent 组。
3. 自动发送 Case Prompt。
4. 通过 SSE 或 run 状态 API 等待结束。
5. 自动回答 Case 中声明的 `ask_user`。
6. 自动处理批准/拒绝脚本。
7. 超时后终止并保存当前 trace。
8. 无论通过、失败还是异常，都必须写出报告。

#### 建议命令

```bash
pnpm agent:bench --case pomodoro-timer-basic
pnpm agent:bench --suite smoke
pnpm agent:bench --suite full
pnpm agent:bench --case pomodoro-timer-basic --repeat 3
```

#### 验收标准

- 无需手工复制 runId。
- 单个 Case 可以从空数据库运行到报告生成。
- 运行结束后可关联 conversationId、conductorRunId 和 task attempts。
- `ask_user` Case 在无人工操作情况下可完成。
- Case 超时不会永久卡住 Runner。
- 连续运行两个 Case 不共享 Workspace、Fact 或 Artifact。

### 9.3 P2：真实 Metrics 与 Trace Collector

#### 目标

消除 Benchmark Report 中写死为 0 或近似计算的指标。

#### 修改位置

- 扩展 `src/server/context-metrics/context-metrics-service.ts`。
- 扩展 `src/server/context-metrics/context-metrics-types.ts`。
- 扩展 `src/server/context-trace/context-trace-service.ts`。
- 新增 `tests/agent-benchmark/runtime/trace-collector.ts`。
- 重构 `tests/e2e-runner/benchmark.ts` 的 metrics 映射。

#### 实现要求

真实计算：

- included / omitted context 数量和原因。
- stale fact rejected 数量。
- JSON repair 次数。
- approval 请求和决定。
- input / output tokens。
- expected role coverage。
- expected output coverage。
- verified input coverage。
- Reviewer 的真实 verification verdict。
- 虚假完成声明的拦截次数。

#### 验收标准

- 报告中不存在用固定 `0` 代替可获取数据的核心指标。
- 每个聚合指标可以追溯到原始事件或数据库记录。
- 分母为 0 时有明确语义，不产生 `NaN`。
- 同一 run 重复评估得到完全相同的确定性指标。

### 9.4 P3：Artifact、Build、Deployment 与 Browser Grader

#### 目标

验证产物是否真正可用，而不只判断 Agent 是否创建了一张卡片。

#### 修改位置

- 新增 `tests/agent-benchmark/graders/artifact-grader.ts`。
- 新增 `tests/agent-benchmark/graders/build-grader.ts`。
- 新增 `tests/agent-benchmark/graders/deployment-grader.ts`。
- 新增 `tests/agent-benchmark/graders/browser-grader.ts`。
- 新增每个 Web App Case 的浏览器交互脚本。
- 报告中增加 build、preview、console 和 interaction 结果。

#### 实现要求

1. Deployment URL 必须来自真实 `deploy_workspace` 工具事件。
2. Preview URL 返回 200 且主体非空。
3. 检查页面控制台异常和静态资源 404。
4. 每个 Web App Case 至少有一个核心交互测试。
5. Browser Grader 失败不能被 Agent 自报“部署成功”覆盖。
6. 保留截图、控制台日志和失败步骤。

#### 验收标准

- “有 Artifact 但页面空白”必须判失败。
- “有部署文本但没有部署事件”必须判失败。
- Todo、Pomodoro 等至少 3 个 Case 有真实交互测试。
- 浏览器失败报告能定位 URL、步骤和错误。

### 9.5 P4：重复采样、统计与预算

#### 目标

把一次 Demo 的偶然成功升级为可比较的稳定性数据。

#### 修改位置

- 新增 `tests/agent-benchmark/reporting/statistics.ts`。
- 新增 `tests/agent-benchmark/reporting/metrics-aggregator.ts`。
- 扩展 CLI：`--repeat`、`--max-cost`、`--max-duration`。
- 扩展 Report Schema，增加 trial 和 aggregate 两层。

#### 实现要求

每个 Case 支持 N 次 trial，并计算：

- Pass@1。
- Trial success rate。
- All-trials-pass rate。
- 平均值、标准差。
- P50 / P95 耗时。
- 平均 Token 和工具调用数。
- 失败原因分布。
- 可选 Wilson 置信区间。

#### 推荐运行策略

```text
本地 Smoke：每个 Case 1 次
Prompt / Context 修改：每个 Case 3 次
Release Benchmark：每个 Case 5 次
关键稳定性 Case：每个 Case 10 次
```

#### 验收标准

- 同一 Case 可以自动重复运行。
- 每次 trial 都使用独立环境。
- 报告同时展示逐次结果和聚合指标。
- 预算超限时标记 `blocked` 或 `budget_exceeded`，不混入普通失败。

### 9.6 P5：上下文策略 A/B Benchmark

#### 目标

量化 AgentMeld Evidence-aware Context 的实际价值。

#### 对比策略

```text
A：full_history
B：summary_only
C：fact_registry
D：evidence_aware_context
```

如果当前代码只保留部分策略，可先实现：

```text
baseline：当前简化/完整上下文策略
candidate：evidence_aware_context
```

#### 修改位置

- 复用或扩展 `src/server/context-policy/strategy-registry.ts`。
- 扩展 `tests/e2e-runner/benchmark.ts` 的 compare 能力。
- 新增 `tests/agent-benchmark/reporting/comparison-reporter.ts`。
- 确保 Context Strategy 写入 run metadata 和 report metadata。

#### 固定变量

- 相同模型和模型参数。
- 相同 Agent Prompt 版本。
- 相同工具权限。
- 相同 Case 和 User Script。
- 相同运行次数。
- 相同预算。

#### 主要比较指标

- Case 成功率。
- required context recall。
- upstream artifact read rate。
- stale fact leakage rate。
- unverified output propagation rate。
- 输入 Token。
- 重试次数。
- 工具失败率。
- 端到端耗时。

#### 验收标准

- 一条命令完成 baseline 与 candidate 对比。
- 报告能够按 Case 和总体展示差异。
- 不允许用不同模型结果冒充 Context Strategy 对比。
- 能识别“成功率提升但成本显著上升”的权衡。

### 9.7 P6：故障注入与安全 Benchmark

#### 目标

主动构造真实运行中常见的失败，而不是等待随机出现。

#### 修改位置

- 新增 `tests/agent-benchmark/runtime/fault-injector.ts`。
- 为 DeepSeek Mock 或 Adapter 增加仅测试环境可用的故障场景。
- 为工具 Registry 增加测试代理或 fault wrapper。
- 新增 recovery、safety、false-completion Cases。

#### 故障类型

- 首次 tool arguments JSON 损坏。
- 首次 `write_artifact` 失败。
- 首次 build 返回非零。
- 首次 deployment 路径不存在。
- SSE 暂时断开。
- child run 中断。
- Artifact type 不匹配 task contract。
- required output 缺失。
- Agent 手写 Artifact ID 或 Deployment URL。

#### 验收标准

- 故障注入可重复，不依赖概率碰撞。
- 报告明确记录注入点。
- 系统只重试受影响节点。
- FailureContext 进入下一 attempt。
- 未验证结果不传播给下游。
- 安全拦截不会被归类为普通模型失败。

### 9.8 P7：报告、回归对比与质量门禁

#### 目标

让 Benchmark 结果可保存、可比较、可用于 release 判断。

#### 修改位置

- 新增 `tests/agent-benchmark/reporting/json-reporter.ts`。
- 新增 `tests/agent-benchmark/reporting/markdown-reporter.ts`。
- 新增 `tests/agent-benchmark/reporting/comparison-reporter.ts`。
- 扩展 `src/server/context-metrics/fixture-report-store.ts`。
- 扩展 `src/server/context-metrics/quality-gates.ts`。

#### 输出结构

```text
.agentmeld-data/benchmark-runs/{benchmarkRunId}/
  manifest.json
  report.json
  report.md
  aggregate-metrics.json
  comparison.json
  trials/
    {caseId}/{trialId}/
      result.json
      context-trace.json
      events.jsonl
      browser.json
      screenshot.png
```

#### Manifest 必须记录

- Git commit 和 dirty 状态。
- AgentMeld 版本。
- 模型和 Provider。
- Prompt 哈希。
- Agent 配置哈希。
- Context Strategy。
- 操作系统、Node 版本。
- Case schema 版本。
- 开始和结束时间。

#### 初始质量门禁建议

```text
required assertion pass rate = 100%
smoke suite success rate >= 80%
upstream artifact read rate >= 90%
stale fact leakage rate = 0%
unverified output propagation rate = 0%
deployment ready rate >= 80%
tool failure rate <= 15%
```

门禁阈值应先通过 3 至 5 轮基线运行校准，不应凭空设定后立刻阻断开发。

#### 验收标准

- 每次运行生成 JSON 和 Markdown。
- 可以比较同一 Case 的两个版本。
- Regression Report 能指出具体退化指标。
- 报告保留失败 trace，而不是只显示一个红色数字。
- Quality Gate 可以区分 warning 和 blocking failure。

### 9.9 P8：Benchmark Dashboard 与辅助外部评测

#### 目标

将已有本地报告产品化，并增加 Terminal-Bench/SWE-bench 等辅助能力测试入口。

#### 修改位置

- 新增 Benchmark 页面或扩展现有 Fixture Dashboard。
- 新增 Case、Run、Metrics、Regression Diff、Failed Trace 视图。
- 后端增加 Benchmark Run 查询 API。
- 可选增加 Frontend Agent 外部 Benchmark Adapter。

#### UI 最小范围

```text
Benchmark
├─ Suites / Cases
├─ Runs
├─ Trial Results
├─ Metrics
├─ Strategy Comparison
├─ Regression Diff
└─ Failed Trace
```

#### Terminal-Bench 的合理用途

只作为辅助测试：

- 测试 Frontend Engineer 的终端能力。
- 测试 bash、fs_read、fs_patch、构建和错误恢复。
- 对比 AgentMeld Frontend Agent 与简单 ReAct Agent。
- 借鉴 Harbor 的环境隔离和任务验证方式。

不应使用 Terminal-Bench 分数替代：

- 多 Agent DAG 质量。
- 上下文交接质量。
- Fact Registry 正确性。
- Evidence Verification。
- Artifact propagation。
- Reviewer 协作质量。

#### 验收标准

- Dashboard 能查看 Case 成功率和最近运行。
- 可从失败 Case 跳转到 Context Trace。
- 能展示 Context Strategy A/B 差异。
- 外部 Benchmark 结果与 AgentMeld Collaboration Benchmark 分开报告。

## 10. 推荐实施顺序

### 第一阶段：让评分可信

```text
P0 结构化 Assertion
-> P2 真实 Metrics
```

这一步解决“现有评分会不会误判”。在评分器可信之前，不应投入大量模型调用费用。

### 第二阶段：让运行可重复

```text
P1 自动 Runner
-> P4 重复采样
```

这一步解决“每次还要人工创建会话、复制 runId，结果无法重复”。

### 第三阶段：让最终产物可验证

```text
P3 Artifact / Browser Grader
-> P6 故障注入
```

这一步解决“任务看起来成功，但页面打不开或证据不完整”。

### 第四阶段：证明上下文方案价值

```text
P5 Context Strategy A/B
-> P7 报告与门禁
```

这一步输出 AgentMeld 最有差异化的实验结果。

### 第五阶段：产品化

```text
P8 Dashboard / External Benchmark Adapter
```

Dashboard 不应早于可信评分器和自动 Runner。

## 11. 最小可交付版本

如果控制开发量，第一版只完成：

1. 10 个高质量 Case。
2. 结构化 Assertion Schema。
3. 自动创建会话、发送 Prompt、等待完成。
4. 自动回答 `ask_user` 和审批。
5. Runtime、Context、Evidence、Deployment 四类确定性 Grader。
6. Todo、Pomodoro、Expense Tracker 三个 Browser Grader。
7. 每个 Case 重复 3 次。
8. `full_history` 与 `evidence_aware_context` A/B。
9. JSON + Markdown 报告。

达到这一范围后，AgentMeld 就可以可靠回答：

```text
Evidence-aware Context 是否提高完整任务成功率？
下游 Agent 是否真的读取了上游产物？
过期事实是否被阻断？
未验证的完成声明是否被拦截？
工具策略修改是否造成回归？
Prompt 修改提高了成功率，还是只是增加 Token 和重试？
```

## 12. 示例：主色修改 Case

### 输入脚本

```text
用户：做一个 Todo App，主色使用红色。
用户后续更正：主色改为蓝色，不再使用红色。
```

### 预期系统状态

```text
Fact ui.theme.primary_color = red
  status: superseded

Fact ui.theme.primary_color = blue
  status: active
```

### 必需 Assertions

```text
1. Conductor 识别更正消息。
2. Fact Registry 中 blue 为 active。
3. red 不再是 active。
4. UI Agent Context 包含 blue。
5. UI Agent Context 不把 red 作为当前约束。
6. 风格指南声明 blue。
7. Frontend 读取最新版风格指南。
8. 最终 CSS 使用 blue。
9. Reviewer 不依据 red 进行验收。
```

### 评分意义

这个 Case 可以区分：

```text
完整历史：可能同时看到 red 和 blue，依赖模型自行消歧
普通 Summary：可能保留旧摘要，或在压缩中丢失更正关系
Fact Registry：知道 blue 是 active
Evidence-aware Context：不仅知道 blue active，还知道它来自用户更正，并把它传播给相关任务
```

## 13. 示例：Frontend 上游交接 Case

### DAG

```text
r1 PM -> prd
r2 UI dependsOn r1 -> style_guide
r3 Frontend dependsOn r1, r2 -> web_app
r4 Reviewer dependsOn r1, r2, r3 -> review_report
```

### Frontend 必需 Assertions

```text
r1.prd binding verified
r2.style_guide binding verified
r3 Context Snapshot includes both bindings
r3 calls read_artifact for both artifacts
r3 uses fs_write/fs_patch for source changes
r3 build succeeds
r3 deploy_workspace succeeds
r3 web_app output binding verified
```

如果 Frontend 的最终页面正确，但没有读取上游 Artifact，建议将 Case 标记为 `partial` 或按 required assertion 判失败。因为这个 Benchmark 测的不只是最终页面，而是 AgentMeld 的角色化协作协议是否生效。

## 14. 发布前 Benchmark 策略

### 每次代码提交

- TypeScript、Lint、单元测试。
- Case Schema Validation。
- Deterministic Grader 测试。
- 不调用真实 LLM。

### Prompt、Context、Tool Policy 修改

- 运行 5 至 10 个 Smoke Cases。
- 每个 Case 3 次。
- 与上一个稳定版本比较。

### Release Candidate

- 完整 24 Case Suite。
- 每个 Case 5 次。
- 保存完整 Manifest 和 Trace。
- 人工抽查所有失败 Case，以及至少 10% 的通过 Case。

### 费用控制

- 为每个 Case 设置 Token、时间和工具调用上限。
- 先运行确定性 Mock / Replay，再运行真实模型。
- 失败后不要无限重试。
- 对 A/B 实验使用同一 Case 子集和相同 trial 数。

## 15. 最终完成定义

只有同时满足以下条件，才可以把 AgentMeld Benchmark 描述为“完整可用”：

- Benchmark 能自动发起任务，不依赖人工 runId。
- Case 使用结构化、机器可判定 Assertions。
- 评分以 Evidence 和最终环境状态为主。
- Web App 有真实浏览器交互验收。
- 支持隔离环境和重复采样。
- 支持 Context Strategy A/B。
- 支持故障注入和安全 Case。
- 报告记录模型、Prompt、代码、策略和预算元数据。
- 失败能追溯到 task、attempt、context、evidence 和 artifact。
- 同一版本多次运行可以得到稳定、可解释的统计结果。

完成这些工作后，AgentMeld 的 Benchmark 不再只是“跑几个 Demo 看是否成功”，而是一套专门验证多 Agent 编排、证据驱动上下文交接、工具安全和任务恢复能力的 Evaluation System。
