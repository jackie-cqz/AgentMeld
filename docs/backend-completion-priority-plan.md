# 后端当前完成度与收尾优先级计划

## 1. 评估范围

本文档基于分支 `202606191016` 的当前代码，对 Agent-Conference 后端完成度进行重新评估，并列出剩余工作的实施优先级。

当前产品范围限定为：

- Web 本地运行。
- SQLite 本地数据库。
- DeepSeek / OpenAI-compatible Custom Agent。
- 单聊与多 Agent 群聊。
- Orchestrator 计划、调度、重试、证据校验和结果聚合。
- Workspace、Artifact、部署、搜索、审批与上下文压缩。

以下内容明确不计入当前完成度：

- Claude Code SDK Adapter 的真实执行。
- Codex SDK Adapter 的真实执行。
- Electron 桌面端。
- Capacitor 移动端。
- 外部 MCP Server。
- 云端多用户和分布式调度。

主要对照文档：

- `AGENT_BACKEND.md`
- `openspec/specs/orchestrator/spec.md`
- `openspec/specs/tools/spec.md`
- `openspec/specs/persistence/spec.md`
- `openspec/specs/conversation-context/spec.md`
- `specs/06-orchestrator-flow.md`
- `specs/07-tools.md`
- `specs/08-db-schema.md`
- `specs/13-conversation-context.md`
- `specs/16-task-contract-handoff.md`
- `specs/17-orchestrator-plan-review.md`

## 2. 总体完成度

当前限定范围内的后端整体完成度约为：

> **83%**

这个数字不是简单按文件数量计算，而是按“功能是否存在、执行链路是否闭环、异常是否可靠、重启后是否可解释、是否有测试证明”综合评估。

### 分项完成度

| 模块 | 完成度 | 当前判断 |
|---|---:|---|
| 消息入口与 AgentRun | 92% | 消息持久化、Responder、流式执行、中止和 Usage 已接通 |
| DeepSeek Custom Adapter | 90% | 流式文本、Tool Calling、多轮回灌和错误显示基本完成 |
| 工具与审批 | 88% | 12 个工具、审批持久化、重复处理保护和安全检查已实现 |
| Orchestrator | 88% | Plan、DAG、重试、冲突、证据、Recovery 和 Aggregate 已形成主闭环 |
| 上下文工程 | 87% | history、pinned、预算、增量压缩和滚动摘要已接通 |
| Artifact 与部署 | 88% | 产物、版本、预览、部署和发布路径已有较完整实现 |
| 搜索与附件 | 90% | FTS/LIKE 搜索、附件读取和相关 API 已实现 |
| 持久化与重启恢复 | 70% | Run 和审批可恢复，但中间调度与压缩任务状态仍不完整 |
| Workspace 安全 | 78% | 工具路径安全较完整，新文件浏览 API 仍有 symlink 风险 |
| 可观测性与诊断 | 45% | 有状态和部分错误分类，但缺少统一日志与 Run 详情 |
| 端到端验收 | 72% | 401 个测试通过，但缺少完整 DeepSeek-compatible 集成测试 |

### 两种完成度视角

- **核心功能完成度：约 90%**
  - 用户已经可以进行对话、调用 DeepSeek、执行工具、生成产物和运行多 Agent 任务。
- **稳定交付完成度：约 75%**
  - 重启恢复、诊断、安全边界和真实协议级集成测试仍需补齐。

综合后取约 **83%**。

## 3. 当前已经完成的核心能力

以下能力不应再被列为“从零实现”的剩余任务：

1. 用户消息持久化与 Agent responder 选择。
2. AgentRun 创建、阶段更新、中止、Usage 和结束事件。
3. DeepSeek Custom Agent 流式输出。
4. OpenAI Chat Completions 格式的 Tool Calling 循环。
5. `fs_list`、`fs_read`、`fs_write`、`bash`。
6. Artifact 读取、写入、部署和 Workspace 部署。
7. Attachment 读取。
8. `ask_user`、`plan_tasks` 和 `report_task_result`。
9. 写文件、Bash 和 Dispatch Plan 审批。
10. 审批状态持久化与条件更新。
11. Orchestrator 动态 Agent ID 注入和校正。
12. Dispatch Plan 解析、校验和 DAG 波次调度。
13. 子任务重试、Artifact 输出绑定和验收结果。
14. 文件写入证据、命令证据和任务报告校验。
15. 同 wave 文件冲突检测。
16. Recovery 和 Aggregate 阶段。
17. 跨 Run 历史、Pinned Message 和模型窗口预算。
18. 上下文增量压缩和多 chunk 滚动摘要。
19. 消息搜索、Artifact 版本和静态预览。
20. 孤儿 Run 和遗留审批的启动恢复。

## 4. 当前质量基线

最近一次验证结果：

- Vitest：`41` 个测试文件，`401` 个测试通过。
- TypeScript：仍有 1 个错误。
- ESLint：仍有 2 个错误和若干警告。
- 工作区：干净。

当前 TypeScript 阻塞：

- `src/app/api/conversations/[id]/route.ts`
- `updateConversation(id, parsed.data)` 缺少必填的 `now`。

当前与后端直接相关的高风险项：

- Workspace 文件浏览 API 没有 realpath/symlink 边界校验。
- 文件浏览 API 会同步读取完整文件后再截断。
- Pinned 固定上下文超出模型窗口后仍可能继续调用模型。
- Orchestrator Plan 失败路径仍保留 demo plan fallback。

---

## P0 - 修复当前正确性和安全阻塞

### 目标

先让当前分支通过基础质量门槛，并修复可能造成越权读取、错误任务执行或必然失败模型请求的问题。

### 任务

1. 修复 Conversation PATCH 类型错误。
   - 修改 `src/app/api/conversations/[id]/route.ts`。
   - 调用 `updateConversation()` 时传入 `now: Date.now()`。
   - 补充 PATCH API 测试，验证 `updatedAt` 更新。

2. 加固 Workspace 文件浏览 API。
   - 修改 `src/app/api/conversations/[id]/workspace-files/route.ts`。
   - 对 root 和目标路径执行 `realpath` 校验。
   - 拒绝指向 workspace 外部的 symlink、junction 和目录链接。
   - 不使用 `resolved.startsWith(rootPath)` 作为安全判断。
   - 统一复用 `isPathWithin()`。

3. 限制文件读取。
   - 读取前检查文件类型和大小。
   - 只读取最多 50K 字符所需的字节，不先加载整个文件。
   - 检测 NUL 字节或常见二进制 MIME，拒绝文本预览。
   - 为单目录返回数量设置合理上限。

4. 修复 Pinned 超预算行为。
   - 当 system + summary + pinned + current turn + output reserve 已超过窗口时，不调用模型。
   - 返回明确的上下文预算错误。
   - 错误应包含 pinned 数量、估算 token、窗口大小和解决建议。

5. 移除 Orchestrator demo plan fallback。
   - 修改 `src/server/orchestrator-service.ts`。
   - Plan 失败时返回结构化失败，不生成演示任务。
   - 不允许错误 fallback 启动任何子 Agent。

6. 补充回归测试。
   - Workspace `../`、绝对路径、symlink 和 junction。
   - 大文件、二进制文件和文件删除竞态。
   - Pinned 超预算不调用 Adapter。
   - Plan 失败不产生 Dispatch Plan。

### 完成标准

- `pnpm typecheck` 通过。
- Workspace 文件 API 无法读取工作区外部文件。
- Pinned 超预算时不会调用 DeepSeek。
- Plan 失败时不会创建伪造任务。
- P0 相关测试全部通过。

---

## P1 - 上下文压缩任务持久化

### 目标

把目前依赖后台 Promise 的压缩流程升级为可查询、可中止、可恢复的持久化任务。

### 任务

1. 新增 `context_compaction_jobs` 表。
   - `id`
   - `conversation_id`
   - `status`
   - `base_summary_id`
   - `source_start_message_id`
   - `source_end_message_id`
   - `source_message_count`
   - `chunk_count`
   - `model_provider`
   - `model_id`
   - `error_category`
   - `error`
   - `started_at`
   - `finished_at`
   - `created_at`
   - `updated_at`

2. 同一 conversation 只允许一个 `queued/running` 任务。

3. Route 只负责创建任务。
   - 压缩服务负责状态转换和执行。
   - GET API 返回当前任务与最新摘要信息。

4. 增加失败分类和有限重试。
   - 429、网络错误、5xx 可以有限重试。
   - 401、403、缺少 Key 和无效响应不自动重试。

5. 服务启动恢复。
   - 把遗留 `queued/running` 标记为 `interrupted`。
   - 允许用户安全重新发起。

6. 增加取消和重试 API。

7. 保证最终 chunk 成功前不更新摘要覆盖边界。

### 主要文件

- `src/db/schema.ts`
- `src/db/bootstrap.ts`
- `src/server/context-compaction-service.ts`
- `src/server/conversation-context.ts`
- `src/app/api/conversations/[id]/compact/route.ts`
- `src/server/run-recovery.ts`

### 完成标准

- 重复点击不会启动两个 DeepSeek 请求。
- 服务重启后任务不会永久停留在 running。
- 压缩状态、错误和覆盖范围可以查询。
- 中间 chunk 失败时不写入部分摘要。

---

## P2 - Orchestrator 调度状态持久化

### 目标

让服务重启后的 Orchestrator 状态不仅是“被标记 interrupted”，还能够解释已经完成了什么、失败在哪里、如何继续。

### 任务

1. 持久化编译后的 Dispatch Plan。

2. 持久化当前阶段。
   - `plan`
   - `review`
   - `dispatch`
   - `recovery`
   - `aggregate`

3. 持久化 wave 和 task attempt。

4. 持久化 output bindings。
   - `taskId.outputKey -> artifactId`

5. 持久化结构化冲突。
   - 文件路径。
   - wave。
   - task、agent 和 child run。
   - Hash 和冲突状态。

6. 持久化 Recovery Plan 与原计划关系。

7. 增加恢复策略。
   - 不恢复到 LLM stream 中间。
   - 保留已经成功的任务和 Artifact。
   - 允许从失败点重新规划。

8. 为重跑增加来源字段。
   - `resumed_from_run_id`
   - 或等价的运行关联字段。

### 主要文件

- `src/db/schema.ts`
- `src/server/repositories.ts`
- `src/server/orchestrator-service.ts`
- `src/server/dispatch-plan.ts`
- `src/server/run-recovery.ts`
- `src/shared/types.ts`

### 完成标准

- 重启后可以查询原计划、wave、任务尝试和产物绑定。
- 已成功任务不需要重复执行。
- 用户能区分首次运行、重试和重启恢复。
- Recovery 不依赖仅存在于内存中的 Map。

---

## P3 - 统一错误分类与后端诊断

### 目标

让“Agent 没回复”“工具失败”“任务卡住”能够通过 runId 定位，而不是依赖控制台和用户可见系统消息猜测。

### 任务

1. 新增轻量结构化 Logger。

2. 日志上下文字段统一：
   - conversationId
   - runId
   - parentRunId
   - agentId
   - taskId
   - attempt
   - stage

3. 统一错误分类：
   - `provider_auth`
   - `provider_rate_limit`
   - `provider_timeout`
   - `provider_server`
   - `provider_invalid_response`
   - `tool_validation`
   - `tool_execution`
   - `approval_rejected`
   - `approval_interrupted`
   - `workspace_security`
   - `context_overflow`
   - `orchestrator_contract`
   - `run_aborted`
   - `run_interrupted`

4. AgentRun 保存：
   - error category
   - error summary
   - retryable

5. 新增 `GET /api/runs/:id`。
   - Run 信息。
   - 子 Run。
   - task attempt。
   - Tool 执行摘要。
   - Approval。
   - Usage。
   - Recovery 结果。

6. 敏感信息脱敏。
   - API Key。
   - Authorization Header。
   - 附件完整内容。
   - Bash 中可能包含的凭据。

### 完成标准

- 使用一个 runId 可以串起完整后端执行时间线。
- DeepSeek 401、429、超时、5xx 和空响应可以区分。
- 日志和诊断 API 不泄漏密钥。
- 业务代码不再依赖散落的 `console.log`。

---

## P4 - DeepSeek 端到端验收

### 目标

证明真实运行链路能够在不依赖真实 API Key 的情况下稳定回归。

### 任务

1. 建立 DeepSeek-compatible 本地 Mock Server。

2. 覆盖 Chat Completions 流式协议：
   - 普通文本。
   - reasoning content。
   - tool calls。
   - usage。
   - 多轮 Tool Loop。

3. 覆盖 Provider 错误：
   - 401。
   - 403。
   - 429。
   - timeout。
   - 500/502/503。
   - 空 choices。
   - 无效 JSON。

4. 增加完整消息链路测试：
   - 用户消息入库。
   - AgentRun。
   - Adapter stream。
   - Tool 执行。
   - MessagePart 持久化。
   - SSE。
   - run.end。

5. 增加完整 Orchestrator 测试：
   - 成功 DAG。
   - 依赖失败。
   - 缺少报告。
   - 缺少 Artifact。
   - 文件冲突。
   - Recovery 成功与失败。
   - 父 Run 中止。

6. 增加压缩集成测试。
   - 多 chunk。
   - 中间失败。
   - 重试。
   - 重复请求。

### 完成标准

- CI 无需真实 DeepSeek Key 即可验证主链路。
- Provider 和 Tool Loop 失败路径都有确定性测试。
- Orchestrator 的主要成功、失败和恢复路径均有集成测试。

---

## P5 - 文档同步与发布质量门槛

### 目标

清理实现与文档的漂移，并建立可以持续执行的完成标准。

### 任务

1. 更新 `AGENT_BACKEND.md`。
   - 以 DeepSeek Custom Agent 为正式路径。
   - 标记 Claude/Codex 为排除范围或 stub。
   - 更新上下文压缩、审批持久化和证据校验。
   - 删除过期文件行号。

2. 更新 `BACKEND_REMAINING_PRIORITY_PLAN.md`。
   - 标记已经完成的旧 P0-P2。
   - 或由本文档替代并注明废弃。

3. 同步 OpenSpec 与编号 Spec。

4. 清理质量问题。
   - TypeScript 错误。
   - ESLint 错误。
   - 无用导入。
   - `git diff --check` 的尾随空格和 EOF 空行。

5. 建立最终质量命令：

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

6. 增加后端发布检查清单。
   - 空数据库启动。
   - 旧数据库迁移。
   - 缺少 API Key。
   - DeepSeek 连接测试。
   - Workspace 安全。
   - 服务重启恢复。

### 完成标准

- 四条质量命令全部通过。
- `AGENT_BACKEND.md` 与当前代码一致。
- 新成员只阅读目标文档即可理解正式支持范围。
- 不再把 Claude/Codex、桌面端和移动端算入当前完成度。

## 5. 推荐执行顺序

| 顺序 | 优先级 | 原因 |
|---:|---|---|
| 1 | P0 正确性和安全阻塞 | 当前就可能影响构建、安全或任务可信度 |
| 2 | P1 压缩任务持久化 | 长会话已经可用，但后台任务可靠性仍不足 |
| 3 | P2 Orchestrator 状态持久化 | 决定重启后多 Agent 工作能否解释和继续 |
| 4 | P3 诊断体系 | 降低真实 DeepSeek 环境中的排查成本 |
| 5 | P4 端到端验收 | 固化主链路和失败路径 |
| 6 | P5 文档与质量门槛 | 完成最终收口并防止再次漂移 |

## 6. 阶段性完成定义

### 达到 90%

- P0 全部完成。
- P1 压缩任务具备并发保护和持久状态。
- Pinned 超预算和 Plan 失败行为正确。
- TypeScript、Lint 和测试通过。

### 达到 95%

- P2 Orchestrator 调度状态持久化完成。
- P3 Run 详情和错误分类完成。
- DeepSeek Mock Server 覆盖核心协议。

### 达到 100%

- P0-P5 全部完成。
- 四条质量命令全部通过。
- 重启、审批、压缩、Orchestrator 和 Workspace 安全都有端到端验证。
- 文档与实际支持范围完全一致。

## 7. 实施原则与边界

### 7.1 不扩大当前产品范围

实施 P0-P5 时，不要顺带完成以下工作：

- 不补 Claude Code SDK Adapter。
- 不补 Codex SDK Adapter。
- 不增加 Electron、Capacitor 或远程访问能力。
- 不引入 Redis、PostgreSQL、消息队列或远程日志服务。
- 不增加新的 Agent SDK。
- 不把本地单用户系统改造成账号体系。

所有剩余任务都应建立在现有技术栈上：

- Next.js Route Handler。
- SQLite + `better-sqlite3`。
- 当前 `repositories.ts` 持久化边界。
- 当前 EventBus + SSE 增量事件。
- DeepSeek Chat Completions-compatible API。

### 7.2 数据库是持久状态来源

后续新增的任务状态必须遵守：

```text
SQLite:
  保存可以跨进程恢复和审计的状态

内存 Map / Promise resolver:
  只保存当前进程正在执行的控制对象

EventBus:
  只发送实时增量通知

前端 Store:
  保存当前浏览器会话中的投影视图
```

不得再让以下状态只存在于内存中：

- 压缩任务是否正在运行。
- Orchestrator 当前执行到哪个阶段。
- 哪个 task 已完成、失败或正在重试。
- 当前有效的 output bindings。
- 运行最后失败的错误类别。

### 7.3 不实现无法保证的断点续跑

当前系统无法在 LLM 流式输出的中间 token 位置恢复，也不能从 Bash 子进程执行一半的位置恢复。

重启恢复的准确语义应是：

1. 将失联运行标记为 `interrupted`。
2. 保留重启前已经成功持久化的 task、Artifact 和审批记录。
3. 不恢复未完成的 LLM stream 或 Tool Loop。
4. 新建 Run，根据已完成结果重新规划或重跑失败任务。
5. 新 Run 保存对原 Run 的引用。

### 7.4 错误必须分为用户错误和系统错误

用户可修复错误：

- 缺少 API Key。
- Pinned 消息过多。
- 用户拒绝审批。
- Workspace 文件不存在。
- Agent 配置缺少模型。

系统或 Provider 错误：

- DeepSeek 429。
- DeepSeek 5xx。
- 请求超时。
- 模型输出无效 Tool 参数。
- Orchestrator 生成非法 DAG。
- 数据库写入失败。
- 服务重启导致运行失联。

两类错误不能只返回同一个 `"Agent run failed"`。

## 8. P0 详细实施卡：正确性与安全阻塞

### 8.1 Conversation PATCH 修复

#### 当前问题

`src/app/api/conversations/[id]/route.ts` 当前调用：

```typescript
updateConversation(id, parsed.data)
```

但 `UpdateConversationInput` 要求 `now`。这会使 `pnpm typecheck` 失败。

#### 修改方式

Route 中构造完整输入：

```typescript
const updated = updateConversation(id, {
  ...parsed.data,
  now: Date.now()
});
```

不要把 `now` 改为 repository 内部隐式生成，否则会改变现有 repository 的显式时间注入模式，并降低测试可控性。

#### 测试

在 API 测试中增加：

1. PATCH title 后 `updatedAt` 大于或等于旧值。
2. PATCH pinnedMessageIds 后字段正确写入。
3. PATCH archived 后状态正确。
4. 空对象 PATCH 的行为明确：允许 no-op 或返回 400，按现有契约统一。

### 8.2 Workspace realpath 安全

#### 当前问题

逻辑路径：

```text
workspace/link/outside.txt
```

在字符串上位于 workspace 内，但 `link` 可能是指向外部目录的 symlink 或 Windows junction。

仅使用：

```typescript
path.resolve()
resolved.startsWith(rootPath)
```

不能防止这种逃逸。

#### 推荐辅助函数

在 `workspace-utils.ts` 增加只读路径校验：

```typescript
export function resolveExistingPathWithinWorkspace(
  workspaceRoot: string,
  requestedPath: string
): string
```

执行步骤：

1. `path.resolve(workspaceRoot, requestedPath)`。
2. 使用 `isPathWithin()` 校验逻辑路径。
3. 对 workspace root 执行 `fs.realpathSync()`。
4. 对目标执行 `fs.realpathSync()`。
5. 再次用 `isPathWithin(realTarget, realRoot)` 校验。
6. 失败时抛出 `WorkspacePathError` 或带稳定错误码的 Error。

目录列表中的每个 entry 也要考虑：

- 可以显示 symlink 名称。
- 但展开或读取前必须重新执行 realpath 校验。
- 更保守的第一版可以直接过滤所有 symbolic link。

#### Windows 专项

测试至少覆盖：

- Directory junction。
- 大小写不同但属于同一目录。
- `C:\workspace-other` 不能通过 `startsWith("C:\workspace")`。
- `..\` 和混合 `/`、`\`。
- UNC 路径和盘符绝对路径。

### 8.3 Workspace 文件读取限制

#### 推荐常量

复用或集中定义：

```typescript
const WORKSPACE_BROWSER_MAX_TEXT_CHARS = 50_000;
const WORKSPACE_BROWSER_MAX_READ_BYTES = 256 * 1024;
const WORKSPACE_BROWSER_MAX_ENTRIES = 2_000;
```

#### 读取步骤

1. `stat` 判断目标是普通文件。
2. 拒绝目录、socket、设备文件和不支持的类型。
3. 根据扩展名和头部字节判断是否为文本。
4. 只打开有限字节：

```typescript
const handle = fs.openSync(filePath, "r");
const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
fs.readSync(handle, buffer, 0, buffer.length, 0);
fs.closeSync(handle);
```

5. 检测 NUL 字节。
6. 使用 UTF-8 解码并截断字符。
7. 返回：

```typescript
{
  content,
  truncated,
  size,
  encoding: "utf-8",
  language,
  path
}
```

#### 错误状态建议

| 场景 | HTTP |
|---|---:|
| Conversation/Workspace 不存在 | 404 |
| 路径格式非法 | 400 |
| 路径逃逸或 symlink 逃逸 | 403 |
| 目标不是普通文件/目录 | 400 |
| 二进制文件不支持预览 | 415 |
| 文件读取期间消失 | 404 |
| 未知 I/O 错误 | 500 |

### 8.4 Pinned 超预算

#### 当前问题

Pinned 消息被设计为不可自动裁剪。但当固定上下文已经超出模型窗口时，继续调用 DeepSeek 只会得到 Provider 侧 context length 错误。

#### 推荐错误类型

```typescript
interface ContextOverflowDetail {
  code: "CONTEXT_PINNED_OVERFLOW";
  contextWindow: number;
  outputReserve: number;
  systemTokens: number;
  summaryTokens: number;
  pinnedTokens: number;
  currentTurnTokens: number;
  pinnedMessageCount: number;
}
```

AgentRunner 在 Adapter 调用前检测并终止：

1. 创建可见错误 MessagePart。
2. 将 Run 标记为 failed。
3. 保存稳定错误类别 `context_overflow`。
4. 不调用 Adapter。
5. 发出 `message.end` 和 `run.end`。

用户提示应说明：

- 取消部分 Pin。
- 压缩或缩短当前消息。
- 新建 Conversation。

### 8.5 移除 demo plan fallback

#### 当前问题

规划失败后生成 demo plan 会产生两个严重后果：

1. 用户真实任务被替换成演示任务。
2. 系统可能启动错误 Agent 和 Tool。

#### 正确状态

Plan 阶段应返回结构化结果：

```typescript
type PlanStageResult =
  | { status: "planned"; plan: DispatchPlan }
  | { status: "needs_user"; questionId: string }
  | {
      status: "failed";
      errorCategory: "provider" | "invalid_plan" | "missing_tool_call";
      error: string;
      retryable: boolean;
    };
```

失败后：

- 不进入 Dispatch。
- 不创建 child run。
- 不创建 demo Artifact。
- Orchestrator 主消息展示简短失败原因。
- 保留重新发送/重试入口。

## 9. P1 详细实施卡：上下文压缩任务化

### 9.1 数据库结构建议

```sql
CREATE TABLE context_compaction_jobs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  base_summary_id TEXT,
  result_summary_id TEXT,
  source_start_message_id TEXT NOT NULL,
  source_end_message_id TEXT NOT NULL,
  source_message_count INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  completed_chunk_count INTEGER NOT NULL DEFAULT 0,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  error_category TEXT,
  error TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

推荐索引：

```sql
CREATE INDEX idx_compaction_jobs_conversation
ON context_compaction_jobs(conversation_id, created_at);

CREATE INDEX idx_compaction_jobs_status
ON context_compaction_jobs(status, updated_at);
```

SQLite 无法直接用普通 UNIQUE 约束表达“同一会话只能有一个 running”，可以使用：

```sql
CREATE UNIQUE INDEX idx_compaction_jobs_active_conversation
ON context_compaction_jobs(conversation_id)
WHERE status IN ('queued', 'running');
```

如果当前 SQLite 版本或 Drizzle 表达不方便，则必须在 transaction 内条件查询和创建。

### 9.2 状态机

```text
queued
  -> running
  -> complete
  -> failed
  -> aborted
  -> interrupted
```

允许的转换：

| 当前 | 下一状态 |
|---|---|
| queued | running / aborted / interrupted |
| running | complete / failed / aborted / interrupted |
| failed | 不原地重启；创建新 attempt/job |
| complete | 终态 |
| aborted | 终态 |
| interrupted | 终态，可创建重试任务 |

禁止把 `complete` 改回 `running`。

### 9.3 服务接口建议

新增：

```typescript
createCompactionJob(conversationId: string): ContextCompactionJob
startCompactionJob(jobId: string): Promise<void>
abortCompactionJob(jobId: string): boolean
retryCompactionJob(jobId: string): ContextCompactionJob
getActiveCompactionJob(conversationId: string): ContextCompactionJob | null
recoverCompactionJobs(now: number): number
```

运行中的 AbortController 可以保存在：

```typescript
Map<jobId, AbortController>
```

但 Map 不是任务状态来源。

### 9.4 API 建议

```text
GET  /api/conversations/:id/compact
POST /api/conversations/:id/compact
GET  /api/context-compaction-jobs/:jobId
POST /api/context-compaction-jobs/:jobId/abort
POST /api/context-compaction-jobs/:jobId/retry
```

`POST /compact` 推荐返回 `202`：

```json
{
  "job": {
    "id": "ccj_xxx",
    "status": "queued",
    "conversationId": "conv_xxx"
  }
}
```

如果已有运行任务，返回现有任务，而不是再启动一个。

### 9.5 重试规则

| 错误 | 自动重试 |
|---|---|
| 网络连接重置 | 是 |
| 请求超时 | 是，最多 2 次 |
| HTTP 429 | 是，遵守 Retry-After |
| HTTP 500/502/503 | 是 |
| HTTP 401/403 | 否 |
| 缺少 API Key | 否 |
| 空摘要 | 可修复重试 1 次 |
| 覆盖边界冲突 | 否，重新选择窗口 |
| 用户中止 | 否 |

### 9.6 压缩测试矩阵

1. 首次压缩。
2. 二次增量压缩。
3. 同一 Conversation 并发 POST。
4. 中间 chunk 失败。
5. 最终 chunk 失败。
6. 429 后成功。
7. 401 立即失败。
8. 用户中止。
9. 服务重启恢复。
10. 压缩期间新增消息。
11. Pinned 消息位于旧摘要范围内。
12. 摘要边界对应消息被删除或损坏。

## 10. P2 详细实施卡：Orchestrator 状态持久化

### 10.1 推荐拆分的持久化实体

不要把整个 Orchestrator 状态塞进 `agent_runs.error` 或一个巨大 JSON 字段。

建议至少拆成：

```text
orchestration_runs
orchestration_plans
orchestration_tasks
orchestration_task_attempts
orchestration_output_bindings
orchestration_conflicts
```

如果希望第一版控制表数量，可以保留：

```text
agent_runs
orchestration_plans
orchestration_task_results
orchestration_output_bindings
orchestration_conflicts
```

但必须能查询 task attempt，而不是只保存最终 task 结果。

### 10.2 Plan 表建议字段

```text
id
orchestrator_run_id
revision
plan_json
status
user_feedback
created_at
resolved_at
```

`revision` 用于表示：

- 初始计划。
- 用户 revise 后计划。
- Recovery Plan。

### 10.3 Task Attempt 字段

```text
id
orchestrator_run_id
plan_id
task_id
attempt
agent_id
child_run_id
status
error_category
error
report_json
evidence_json
started_at
finished_at
```

### 10.4 Output Binding

当前内存结构：

```text
taskId.outputKey -> artifactId
```

数据库建议字段：

```text
orchestrator_run_id
plan_id
producer_task_id
output_key
artifact_id
created_at
```

建立唯一约束：

```text
(plan_id, producer_task_id, output_key)
```

### 10.5 重启后恢复算法

```text
1. 读取 interrupted Orchestrator Run
2. 读取最后有效 Plan
3. 读取全部 task attempt
4. 将 complete 且证据有效的 task 视为已完成
5. 重建 outputBindings
6. 将 running task attempt 标记 interrupted
7. 计算未完成 task 和被阻塞 task
8. 创建新的 recovery run
9. 把原 runId 写入 resumedFromRunId
10. 重新进入 Recovery Plan，而不是直接继续旧 Promise
```

### 10.6 必须防止的重复副作用

- 已完成的 `fs_write` 任务不能无条件重跑。
- 已创建的 Artifact 不能因恢复重复创建多个等价版本。
- 已批准并执行的 Bash 不应再次执行。
- 已完成 output binding 必须复用。
- 失败任务可以重试，但必须创建新的 attempt。

## 11. P3 详细实施卡：诊断与错误模型

### 11.1 统一错误对象

```typescript
interface BackendErrorDetail {
  category: BackendErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  providerStatus?: number;
  stage?: string;
  toolName?: string;
  approvalId?: string;
  cause?: string;
}
```

用户可见 `message` 与开发诊断 `cause` 分离。

### 11.2 Logger 接口

```typescript
logger.info("run.started", context, data);
logger.warn("provider.retry", context, data);
logger.error("task.failed", context, error);
```

Context：

```typescript
interface LogContext {
  conversationId?: string;
  runId?: string;
  parentRunId?: string;
  agentId?: string;
  taskId?: string;
  attempt?: number;
  stage?: string;
}
```

### 11.3 脱敏规则

至少屏蔽：

- `apiKey`
- `authorization`
- `token`
- `secret`
- `password`
- `cookie`
- `set-cookie`

Tool 参数中：

- Bash command 默认只记录摘要或 Hash。
- 文件内容不进入日志。
- Attachment 内容不进入日志。
- LLM 完整 prompt 默认不进入结构化日志。

### 11.4 Run 详情 API 响应建议

```json
{
  "run": {},
  "children": [],
  "orchestration": {
    "stage": "dispatch",
    "plans": [],
    "tasks": [],
    "attempts": [],
    "bindings": [],
    "conflicts": []
  },
  "approvals": [],
  "usage": {},
  "errors": []
}
```

该 API 是诊断 API，不应返回：

- API Key。
- 完整 system prompt。
- 完整 Tool Result。
- 完整附件内容。

## 12. P4 详细实施卡：DeepSeek Mock Server

### 12.1 Mock Server 目标

Mock Server 必须模拟协议，不只是 mock Adapter 函数。

测试应真实经过：

```text
CustomAgentAdapter
  -> OpenAI SDK
  -> HTTP Mock Server
  -> SSE chunks
  -> Tool Loop
  -> consumeStream
  -> Message persistence
```

### 12.2 必须支持的响应脚本

```text
/text-stream
/reasoning-stream
/tool-call
/multi-tool-round
/usage
/401
/403
/429
/timeout
/500
/empty
/invalid-json
/disconnect-mid-stream
```

可以通过测试请求 header 或 modelId 选择场景，不需要启动多个 Server。

### 12.3 Tool Loop 集成用例

示例：

```text
用户: 读取 package.json 并告诉我项目名

第 1 轮:
  模型调用 fs_read

Tool:
  返回 package.json 内容

第 2 轮:
  模型输出项目名
```

断言：

- 只创建一个 AgentRun。
- Message parts 包含 tool_use、tool_result、text。
- Tool callId 正确配对。
- Usage 正确累计。
- 最终 Message 状态为 complete。

### 12.4 Orchestrator 集成用例

至少准备以下固定脚本：

1. 明确需求直接规划。
2. 需求不明确调用 ask_user。
3. 合法并行 DAG。
4. 非法 Agent ID。
5. 循环依赖。
6. 子任务无报告。
7. 子任务测试失败。
8. Artifact 缺失。
9. 同 wave 文件冲突。
10. Recovery Plan 成功。
11. Recovery Plan 仍失败。
12. Aggregate 明确报告部分完成。

## 13. P5 详细实施卡：质量与文档收口

### 13.1 质量命令执行顺序

```text
1. pnpm typecheck
2. pnpm lint
3. pnpm test
4. pnpm build
5. git diff --check
```

前一项失败时仍可继续收集后续结果，但不得宣布完成。

### 13.2 警告处理原则

必须清理：

- 业务代码未使用导入。
- React Hook 依赖警告。
- Render 期间不纯调用。
- Effect 中同步派生状态。
- 安全代码中的未使用校验函数。

测试代码中的 `_input` 一类警告可以通过明确命名或 ESLint 局部规则处理，但不要全局关闭规则。

### 13.3 数据库迁移验证

至少测试：

1. 全新空目录启动。
2. 当前旧数据库启动。
3. 已有 `agent_runs` 但没有新列。
4. 已有 pending approval。
5. 已有 running Run。
6. 已有 context summary。
7. 迁移重复执行两次。

所有 migration 必须幂等。

### 13.4 文档状态标记

建议在旧文档顶部增加：

```markdown
> 状态：部分过时。
> 当前剩余任务请参考 `docs/backend-completion-priority-plan.md`。
```

不要直接删除旧计划，因为其中仍包含设计背景；但不能让新开发者误以为旧 P0-P2 尚未实现。

## 14. 依赖关系

```text
P0 正确性与安全
  ├─> P1 压缩任务持久化
  ├─> P2 Orchestrator 状态持久化
  └─> P4 端到端测试

P1 + P2
  └─> P3 诊断 API

P0 + P1 + P2 + P3
  └─> P4 完整端到端验收

P0-P4
  └─> P5 文档与发布收口
```

P3 可以和 P1/P2 部分并行，但 Run 详情 API 的最终结构依赖持久化表设计。

## 15. 建议拆分的提交

避免把所有后端收尾一次提交。

推荐：

```text
fix(api): pass update timestamp when patching conversations
fix(workspace): harden file browser path and read limits
fix(context): reject pinned context overflow before adapter call
fix(orchestrator): remove demo fallback plan

feat(compaction): persist compaction jobs and recovery state
test(compaction): cover concurrency retry abort and restart

feat(orchestrator): persist plans attempts bindings and conflicts
feat(recovery): rebuild orchestrator recovery input from database

feat(observability): add backend error categories and structured logger
feat(api): add run diagnostics endpoint

test(deepseek): add chat completions protocol mock server
test(orchestrator): add full dispatch recovery integration suite

docs(backend): align supported scope and completion status
chore(quality): clear type lint and diff-check failures
```

每个提交尽量只处理一个行为边界，方便通过 Git diff 和测试定位回归。

## 16. 最终验收清单

### 基础链路

- [ ] 用户消息能够触发 DeepSeek Custom Agent。
- [ ] 流式文本、reasoning、Tool Calling 和 Usage 正常。
- [ ] Run 状态不会永久停留在 running。
- [ ] 用户中止可以停止 Adapter 和 Tool。

### Orchestrator

- [ ] 不明确需求调用 ask_user。
- [ ] 明确需求生成合法 Plan。
- [ ] 非法 Agent ID 被拒绝或确定性校正。
- [ ] DAG 依赖顺序正确。
- [ ] 同 wave 可以并发。
- [ ] 失败任务按策略重试。
- [ ] 任务证据来自真实工具执行。
- [ ] 文件冲突影响最终完成状态。
- [ ] Plan 失败不会生成 demo task。
- [ ] 重启后可解释已完成任务和失败位置。

### 上下文

- [ ] Summary、Pinned、Recent 和 Current Turn 预算一致。
- [ ] Pinned 超预算时不调用模型。
- [ ] 二次压缩不重复旧消息。
- [ ] 多 chunk 只在最终成功后保存摘要。
- [ ] 同一会话不能并发启动两个压缩任务。
- [ ] 重启后压缩任务进入 interrupted。

### Workspace 与 Artifact

- [ ] `..`、绝对路径和混合分隔符不能逃逸。
- [ ] Symlink 和 junction 不能逃逸。
- [ ] 大文件不会被完整读入内存。
- [ ] 二进制文件不会作为 UTF-8 文本返回。
- [ ] Artifact 预览路径安全。
- [ ] Deployment 发布路径安全。

### 持久化与审批

- [ ] 同一审批只能处理一次。
- [ ] Run 中止取消相关 pending approval。
- [ ] 重启后 pending approval 进入 interrupted。
- [ ] 已完成 task 和 output binding 可以从数据库查询。

### 诊断

- [ ] Run 详情可以按 runId 查询。
- [ ] Provider 401、429、timeout 和 5xx 分类明确。
- [ ] Tool 和审批错误分类明确。
- [ ] 日志和 API 不泄漏 API Key。

### 质量门槛

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `git diff --check`
