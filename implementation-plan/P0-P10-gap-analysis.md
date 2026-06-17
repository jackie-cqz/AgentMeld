# P0-P10 当前缺口分析

本文档记录当前代码相对 `implementation-plan/`、`specs/`、`openspec/specs/` 的实际缺口。判断口径以代码中已经可运行、可测试、可由用户在 UI 中完成闭环为准，而不是仅看文件或组件是否存在。

## 当前验证结果

最近一次整体检查结果：

- `npm run typecheck` 通过。
- `npm test -- --run` 通过，24 个测试文件、253 个测试全部通过。
- `npm run lint` 通过，但存在 26 个 warning。
- `npm run build` 通过，Next 16.2.6 production build 成功。
- 当前目录不是 git 仓库，无法用 `git status` 判断变更边界。

## 总体结论

当前项目已经具备 Web MVP 的基础骨架：

- Next Web 应用可以构建。
- SQLite/Drizzle schema 与 bootstrap 已落地。
- Conversation、Message、AgentRun、Artifact 等核心实体已持久化。
- SSE、EventBus、前端 store reducer 已串联。
- 三栏 UI 已成形：左侧会话、中间聊天、右侧 Artifact 预览。
- AgentRunner、MockAdapter、CustomAdapter、工具系统和部分审批队列已存在。

主要缺口集中在：

- 部分能力只有后端/API/组件，没有前端操作入口。
- P9 Orchestrator 服务存在，但尚未接入 AgentRunner 主流程。
- CustomAdapter 与 `write_artifact` 工具存在 artifact 重复写入风险。
- README 中 Electron/Mobile 等描述明显超前于当前代码实现。

## P0-P10 完成度

| 优先级 | 状态 | 说明 |
|---|---|---|
| P0 | 完成 | 工程基础、依赖、脚本、Next 16 构建链路可用。 |
| P1 | 完成 | 类型、DB schema、bootstrap、seed、repository 基础能力已落地。 |
| P2 | 完成 | EventBus、SSE API、前端 StreamProvider、store reducer 已可用。 |
| P3 | 基本完成 | 对话创建、发送消息、`@Agent`、消息流和聊天 UI 已可用。 |
| P4 | 基本完成 | AgentRunner、adapter registry、MockAdapter、abort API 已实现。 |
| P5 | 部分完成偏高 | 工具、安全检查、pending queue 已有；bash 审批和审批 UI 未闭环。 |
| P6 | 部分完成 | Artifact API、service、panel、iframe preview 已有；版本/选择/部署未闭环。 |
| P7 | 部分完成 | CustomAdapter 与 Settings API 已有；Settings UI 和 SDK adapters 未实现。 |
| P8 | 部分完成 | Agent 创建 API 与 dialog 组件已有；Agent Builder 未挂到 UI。 |
| P9 | 骨架阶段 | 编排 service、plan tools、pending plan 已有；主流程未接入。 |
| P10 | 部分完成 | 测试/build 已过；发布文档、README 校准、扩展边界仍需整理。 |

## 关键缺口清单

### G1. Orchestrator 未接入主运行链路

相关文件：

- `src/server/orchestrator-service.ts`
- `src/server/agent-runner.ts`
- `src/server/conversation-service.ts`
- `src/server/tools/orchestrator-tools.ts`
- `src/app/api/dispatch-plans/[id]/resolve/route.ts`

当前情况：

- `executeOrchestrator()` 已存在。
- `plan_tasks`、`report_task_result` 工具已存在。
- pending dispatch plan 队列和 resolve API 已存在。
- 但 `executeOrchestrator()` 没有被 `AgentRunner` 或 `conversation-service` 调用。
- 群聊默认只会启动 Orchestrator agent 的普通 adapter 回复，不会进入 plan approval -> child runs 的编排流程。
- `buildDemoPlan()` 仍是 demo 计划生成，不是由真实 Orchestrator LLM 产出。

需要补齐：

1. 在 `AgentRunner` 中识别 `agent.isOrchestrator`。
2. 将 Orchestrator run 接入 `executeOrchestrator()`。
3. 明确 Orchestrator 消息是否仍由 adapter 生成，还是由 orchestration service 接管。
4. 将 `dispatch.plan.pending` 显示到 UI。
5. 用户批准后执行 DAG child runs。
6. child run 结果需要真实汇总，不应固定返回 complete。

### G2. Pending Approval 缺前端闭环

相关文件：

- `src/server/pending-writes.ts`
- `src/server/pending-bash.ts`
- `src/server/dispatch-plan-manager.ts`
- `src/app/api/pending-writes/[id]/resolve/route.ts`
- `src/app/api/pending-bash/[id]/resolve/route.ts`
- `src/app/api/dispatch-plans/[id]/resolve/route.ts`
- `src/stores/app-store.ts`

当前情况：

- store 已保存 `pendingWrites`、`pendingBashCommands`、`pendingDispatchPlans`。
- resolve API 已存在。
- SSE resolved 事件也已进 store reducer。
- 但 UI 中没有审批卡片、审批面板或 approve/reject 操作入口。
- `bash` 工具对需要审批的命令目前是 MVP auto-approve，并未调用 `registerPendingBash()`。

需要补齐：

1. 新增 `PendingApprovalPanel` 或在 ChatPanel 内渲染 pending cards。
2. 支持 `fs_write` approve/reject，并显示 old/new diff。
3. 支持 bash approve/reject，并展示 command、cwd、reason。
4. 支持 dispatch plan approve/reject/revise。
5. 修改 `bash` 工具，让需要审批的命令真正进入 `registerPendingBash()`。
6. 超时、abort、run failed 时取消对应 pending items。

### G3. CustomAdapter 与 write_artifact 存在重复创建风险

相关文件：

- `src/server/adapters/custom-agent-adapter.ts`
- `src/server/tools/write-artifact.ts`
- `src/server/agent-runner.ts`

当前情况：

- `write_artifact` 工具内部已经调用 `createArtifact()` 写入 DB。
- CustomAdapter 执行 `write_artifact` 后又发出 `artifact.create` event。
- AgentRunner 收到 `artifact.create` 后还会再次 `createArtifact()`。
- 这会导致同 ID 重复 insert，可能让 run 失败，或导致 artifact 状态不一致。
- CustomAdapter 构造的 `artifact.create.artifact.content` 也只是工具返回值，不是完整 artifact content。

需要补齐：

1. 二选一统一 artifact 创建职责。
2. 推荐方案：`write_artifact` 创建 DB artifact 后返回完整 artifact，AgentRunner 对已存在 artifact 只追加 `artifact_ref`。
3. 或者让 tool 不直接写 DB，只返回 artifact draft，由 AgentRunner 统一持久化。
4. 增加 CustomAdapter + `write_artifact` 集成测试。

### G4. ToolContext.runId 没有传入真实 runId

相关文件：

- `src/server/adapters/custom-agent-adapter.ts`
- `src/server/tools/types.ts`
- `src/server/tools/fs-write.ts`
- `src/server/tools/bash.ts`

当前情况：

- CustomAdapter 的 `ToolContext.runId` 当前是空字符串。
- 注释写了由 AgentRunner 填充，但 AgentRunner 只填充 StreamEvent 的 ids，没有填充 ToolContext。
- pending write/bash 需要 runId 时会拿到空字符串。

需要补齐：

1. 将 `runId` 加入 `AdapterInput`。
2. AgentRunner 构造 AdapterInput 时传入真实 run id。
3. CustomAdapter 创建 ToolContext 时使用 `input.runId`。
4. pending queue、abort cleanup、测试都要覆盖真实 runId。

### G5. Agent Builder 组件存在但没有挂载

相关文件：

- `src/components/create-agent-dialog.tsx`
- `src/components/sidebar.tsx`
- `src/app/api/agents/route.ts`
- `src/app/api/agents/[id]/route.ts`
- `src/server/agent-service.ts`

当前情况：

- `CreateAgentDialog` 已实现。
- `GET/POST/PATCH/DELETE /api/agents` 已存在。
- Sidebar 里有 “Agents” nav button。
- 但 `CreateAgentDialog` 没有被任何组件引用。
- “Agents” tab 当前只是按钮样式，不会切换到 Agent 管理视图。
- 内置 Agent 当前不可 update/delete，但计划里提到内置 Agent 不可删、可编辑部分配置，这里存在策略偏差。

需要补齐：

1. 实现 Sidebar tab 状态。
2. 新增 `AgentsPanel` 或 `AgentBuilderPanel`。
3. 将 `CreateAgentDialog` 挂到 Agent 管理入口。
4. 创建 Agent 后刷新 store 中的 agents。
5. 支持编辑自定义 Agent。
6. 明确内置 Agent 是否允许编辑 prompt/model/tools，并让代码与文档一致。

### G6. Settings API 已有，但 Settings UI 缺失

相关文件：

- `src/app/api/settings/route.ts`
- `src/server/settings-service.ts`
- `src/components/sidebar.tsx`
- `CLAUDE.md`

当前情况：

- Settings GET/PATCH 已实现。
- GET 会 mask API key。
- key fallback 顺序支持 agent.apiKey -> app_settings -> env。
- 但 UI 没有设置入口。
- `CLAUDE.md` 中提到 Sidebar 齿轮设置面板，当前 Sidebar 没有这个按钮。

需要补齐：

1. 新增 `SettingsDialog`。
2. Sidebar 增加设置入口。
3. 支持 OpenAI、DeepSeek、Volcano Ark、Anthropic key/base url 配置。
4. 保存后不要在前端展示明文 key。
5. CustomAdapter 缺 key 时，错误消息应提示用户去 Settings 配置。

### G7. Artifact Preview 已有，但交互和版本能力不足

相关文件：

- `src/components/artifact-panel.tsx`
- `src/server/artifact-service.ts`
- `src/app/api/artifacts/[id]/preview/route.ts`
- `src/server/tools/read-artifact.ts`
- `src/server/tools/write-artifact.ts`

当前情况：

- ArtifactPanel 会展示当前 conversation 的第一个 artifact。
- web_app iframe preview 已有。
- document/image/source view 已有。
- VersionHistory 只是占位文案。
- Artifact reference 在消息中不可点击切换右侧具体 artifact。
- 多 artifact 列表、版本链选择、删除/重命名/更新 UI 未闭环。

需要补齐：

1. store 增加 `activeArtifactId`。
2. 点击 `artifact_ref` 时右侧展示对应 artifact。
3. 右侧增加 artifact 列表或 dropdown。
4. 完成 version chain 查询和 UI 展示。
5. 支持 artifact rename/delete/update 的前端操作。
6. web_app preview 应支持多文件引用的基本策略，避免只服务 entry 文件导致 css/js 资源不可访问。

### G8. Bash 审批策略未按 P5 完成

相关文件：

- `src/server/tools/bash.ts`
- `src/server/security.ts`
- `src/server/pending-bash.ts`

当前情况：

- banned pattern 会直接拦截。
- 需要审批的命令模式已经定义。
- 但 `needsApproval(command)` 命中后当前没有注册 pending bash，而是 MVP auto-approve。

需要补齐：

1. 接入 `registerPendingBash()`。
2. 发布 `bash_command.pending` 事件。
3. resolve 后继续执行或返回拒绝结果。
4. abort run 时取消 pending bash。
5. 增加 bash approval API + tool integration 测试。

### G9. Attachments 只有类型和占位 UI

相关文件：

- `src/shared/types.ts`
- `src/db/schema.ts`
- `src/components/message-input.tsx`
- `src/components/message-parts.tsx`

当前情况：

- `attachments` 表存在。
- `image_attachment`、`file_attachment` MessagePart 类型存在。
- Composer 有附件图标按钮。
- 但没有上传 API、文件选择、保存文件、发送附件消息的流程。

需要补齐：

1. 新增 attachment upload API。
2. 保存文件到 conversation workspace 或 data dir。
3. 生成 attachment metadata。
4. MessageInput 支持选择、预览、移除附件。
5. sendMessage API 支持 attachment ids。
6. Agent input 支持附件上下文，vision model 再另行接入。

### G10. README 与当前实现不一致

相关文件：

- `README.zh-CN.md`
- `implementation-plan/P10-release-hardening-and-extensions.md`
- `specs/12-desktop-electron.md`
- `specs/14-mobile-remote.md`
- `specs/15-external-mcp.md`
- `specs/16-message-search.md`

当前情况：

- README 中写到 Electron 桌面版可用、mobile app、Electron ABI 等较完整能力。
- 当前根目录没有 `apps/`、Electron 或 mobile 实现目录。
- Search、External MCP、deployment publishing、diagram artifact 等仍主要是 specs/openspec 规划。

需要补齐：

1. README 增加“当前 Web MVP 状态”说明。
2. 将 Electron/Mobile 标记为 planned/deferred，除非实际创建实现目录。
3. P10 文档中明确哪些是本阶段交付，哪些是后续阶段。
4. 增加 MVP limitations。

## 建议修复顺序

### 第一批：修正会影响运行稳定性的缺口

1. 修复 CustomAdapter + `write_artifact` 重复创建 artifact。
2. 将真实 `runId` 传入 ToolContext。
3. 为 artifact tool/custom adapter 增加集成测试。

### 第二批：补齐用户可操作闭环

1. 实现 PendingApprovalPanel。
2. bash 接入 pending approval。
3. 挂载 Agent Builder。
4. 挂载 SettingsDialog。

### 第三批：完成多 Agent 编排 MVP

1. Orchestrator 接入 AgentRunner。
2. dispatch plan pending UI。
3. approve 后执行 child runs。
4. 汇总真实 child run 状态。

### 第四批：Artifact 与发布收尾

1. Artifact 点击选择与版本历史。
2. web_app preview 多文件资源服务。
3. README 校准。
4. lint warning 清理。
5. 手工 smoke flow 文档。

## MVP 可交付定义建议

建议把当前 MVP 收敛为以下验收闭环：

1. 用户可以创建对话。
2. 用户可以创建/配置 custom Agent。
3. 用户可以配置全局 API keys。
4. 用户发送消息后，Agent 可以流式回复。
5. Agent 可以调用 `write_artifact` 生成 document/web_app。
6. 用户可以点击 artifact_ref，在右侧预览对应 artifact。
7. `fs_write` 和高风险 `bash` 必须经过 UI 审批。
8. 群聊默认 Orchestrator 可以生成 dispatch plan。
9. 用户批准 dispatch plan 后，子 Agent runs 被启动并汇总。
10. `typecheck/test/lint/build` 全部通过，README 与实际能力一致。

