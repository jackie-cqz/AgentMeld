# Agent-Conference MVP 系统实现总计划

## 1. 项目目标

Agent-Conference 要实现的是一个 local-first 的多 Agent 协作工作空间，产品体验参考 IM 群聊：Agent 是联系人，会话是工作空间，Orchestrator 是群里的项目经理，产物和文件是共享上下文。

第一阶段不追求一次性做完 README 里的全部能力，而是先交付一个可运行、可扩展、符合规格契约的 MVP。MVP 的核心价值是把一条用户消息完整走通：

```text
用户发送消息
  -> 写入 SQLite
  -> 选择响应 Agent
  -> AgentRunner 创建 run
  -> Adapter 流式产生 StreamEvent
  -> EventBus 广播
  -> SSE 推送到前端
  -> Zustand reducer 更新 UI
  -> 工具 / 产物 / workspace 状态可见且可审计
```

## 2. 总参考文档

实现前必须优先参考这些已有文件：

| 类型 | 文件 | 用途 |
|---|---|---|
| 项目入口 | `AGENTS.md` | Codex/协作入口规则，要求先读 `CLAUDE.md` 与 specs |
| 协作规则 | `CLAUDE.md` | 技术栈、五层架构、安全约束、spec 驱动开发规则 |
| 用户产品说明 | `README.zh-CN.md` | 产品定位、功能清单、快速开始、运行形态 |
| 深度总览 | `DEEP-OVERVIEW.md` | 产品问题、目标架构、数据流、后续方向 |
| 后端链路说明 | `AGENT_BACKEND.md` | 消息入口、AgentRunner、Adapter、Tool Loop、Orchestrator 的详细链路 |
| OpenSpec 索引 | `openspec/project.md` | OpenSpec capability 与 legacy specs 的映射 |
| OpenSpec 当前契约 | `openspec/specs/*/spec.md` | 当前有效的能力契约，优先级高于实现猜测 |
| 编号详细规格 | `specs/*.md` | 字段、事件、API、UI、工具、安全等细节 |
| 扩展配方 | `skills/*.md` | 新增 adapter/tool/message part/artifact type 的操作指南 |
| Next 本地文档 | `node_modules/next/dist/docs/` | Next.js 16.2.6 的真实框架约定 |

## 3. 架构边界

实现必须保持 `CLAUDE.md` 中定义的五层边界：

| 层 | 名称 | MVP 模块 |
|---|---|---|
| L5 | UI 组件 | sidebar、chat panel、message parts、artifact preview、agent/settings dialogs |
| L4 | State + Transport | Zustand store、SSE client、StreamEvent reducer |
| L3 | Application Services | ConversationService、AgentRunner、EventBus、ToolRegistry、workspace utils |
| L2 | Agent Platform Adapters | MockAdapter、CustomAgentAdapter，SDK adapters 先保留扩展边界 |
| L1 | Persistence | Drizzle schema、SQLite client、bootstrap、seed、workspace filesystem |

关键原则：

- UI 不直接调用 LLM SDK。
- Adapter 不直接写 DB、不直接推 SSE。
- Message 内容始终是 `MessagePart[]`。
- Artifact 独立于 Message，Message 只通过 `artifact_ref` 引用。
- 所有文件系统和命令能力必须经过 workspace 沙箱。
- 所有跨边界输入必须用 zod 校验。

## 4. MVP 范围

### 必须完成

1. Web 应用可以通过 `pnpm dev` 启动。
2. SQLite 数据库自动初始化到 `.agent-conference-data/agent-conference.db`。
3. Seed 内置 Mock agents 和 Orchestrator。
4. 用户可以创建/打开单聊和群聊。
5. 用户消息按 `MessagePart[]` 存储并广播 `message.added`。
6. MockAdapter 能流式回复，完整走通 `run.start -> message.* -> part.* -> run.end`。
7. 前端通过一个 SSE 连接消费 `StreamEvent`。
8. 前端 reducer 能确定性应用消息、part、tool、artifact、run 事件。
9. Agent-Conference-managed tools 支持 `read_artifact`、`write_artifact`、`fs_list`、`fs_read`、`fs_write`、`bash` 的 MVP 版本。
10. `document` 和 `web_app` artifact 可创建、引用、预览。
11. Custom OpenAI-compatible agent 能通过 settings/API key 运行。
12. 群聊无 @ 时能触发 Orchestrator 的基础计划/审批/调度路径。

### 暂缓完成

- Electron 打包。
- 移动伴随端。
- Claude Code SDK 完整审批桥。
- Codex SDK 完整 MCP bridge。
- PPTX 导出、diagram artifact、global search、external MCP。
- 外部静态发布。
- 多用户/权限系统。

## 5. 优先级路线

| 优先级 | 文档 | 主题 | 完成后系统状态 |
|---|---|---|---|
| P0 | `P0-project-foundation.md` | 工程基座 | Next 16 项目可安装、可构建 |
| P1 | `P1-domain-types-and-db.md` | 类型与数据库 | 核心实体可持久化 |
| P2 | `P2-event-bus-and-sse.md` | 事件总线与 SSE | 前后端实时通道可用 |
| P3 | `P3-conversations-and-messages.md` | 会话与消息 | 用户可发结构化消息 |
| P4 | `P4-agent-runner-and-mock-adapter.md` | AgentRunner 与 MockAdapter | 可无 key 跑完整 agent run |
| P5 | `P5-tools-and-workspace-sandbox.md` | 工具与沙箱 | Agent 可安全读写 workspace |
| P6 | `P6-artifacts-and-preview.md` | 产物与预览 | 产物独立存储并可预览 |
| P7 | `P7-custom-agent-adapter-and-settings.md` | Custom adapter 与 settings | 可接 OpenAI-compatible provider |
| P8 | `P8-agent-builder-and-presets.md` | Agent Builder | 用户可创建/编辑 Agent |
| P9 | `P9-orchestrator-and-plan-review.md` | Orchestrator | 群聊可规划、审批、调度 |
| P10 | `P10-release-hardening-and-extensions.md` | 加固与扩展边界 | MVP 可交付并为后续 SDK/桌面铺路 |

## 6. 关键数据模型

参考：

- `openspec/specs/core-domain/spec.md`
- `openspec/specs/persistence/spec.md`
- `specs/01-core-entities.md`
- `specs/08-db-schema.md`

MVP 要落库的表：

| 表 | 核心责任 |
|---|---|
| `agents` | Agent 配置、adapter、provider、model、tools、key override |
| `conversations` | 会话元数据、参与 agent、审批模式、pin 状态 |
| `messages` | 结构化消息 parts、状态、run 关联 |
| `artifacts` | 产物内容、版本链、创建者 |
| `workspaces` | 每个会话的 sandbox/local 工作区策略 |
| `attachments` | 用户上传附件元数据 |
| `agent_runs` | 每次 Agent 执行审计记录 |
| `conversation_context_summaries` | 上下文压缩摘要 |
| `app_settings` | 本地单用户全局 key/settings |

## 7. 关键事件模型

参考：

- `openspec/specs/stream-events/spec.md`
- `specs/02-stream-events.md`
- `specs/03-message-parts.md`
- `specs/09-frontend-architecture.md`

MVP 事件必须覆盖：

- `run.start`
- `run.end`
- `message.added`
- `message.removed`
- `message.start`
- `message.end`
- `part.start`
- `part.delta`
- `part.end`
- `tool.call`
- `tool.result`
- `artifact.create`
- `artifact.update`
- `fs_write.pending`
- `fs_write.resolved`
- `bash_command.pending`
- `bash_command.resolved`
- `dispatch.plan.pending`
- `dispatch.plan.resolved`
- `dispatch.task.*`
- `run.usage`
- `message.usage`
- `heartbeat`

## 8. API 草图

API 位置遵循 Next App Router `src/app/api/**/route.ts`。Route Handler 约定参考：

- `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`

MVP API 草图：

| Method | Path | 用途 |
|---|---|---|
| `GET` | `/api/stream` | 全局 SSE |
| `GET` | `/api/bootstrap` | 首屏快照 |
| `GET/POST` | `/api/agents` | Agent 列表与创建 |
| `GET/PATCH/DELETE` | `/api/agents/[id]` | Agent 详情、编辑、删除/停用 |
| `GET/POST` | `/api/conversations` | 会话列表与创建 |
| `GET/PATCH/DELETE` | `/api/conversations/[id]` | 会话详情、编辑、删除 |
| `GET/POST` | `/api/conversations/[id]/messages` | 消息列表与发送 |
| `POST` | `/api/messages/[id]/withdraw` | 撤回 |
| `POST` | `/api/messages/[id]/regenerate` | 重新生成 |
| `GET` | `/api/artifacts` | 产物库 |
| `GET/PATCH/DELETE` | `/api/artifacts/[id]` | 产物详情、编辑、删除 |
| `GET` | `/api/artifacts/[id]/preview` | web app 预览 |
| `GET/PATCH` | `/api/settings` | app settings |
| `POST` | `/api/runs/[id]/abort` | 中止 run |
| `POST` | `/api/pending-writes/[id]/resolve` | 审批文件写入 |
| `POST` | `/api/pending-bash/[id]/resolve` | 审批命令 |
| `POST` | `/api/dispatch-plans/[id]/resolve` | 审批/修订 orchestrator plan |

## 9. 前端 UI 草图

参考：

- `openspec/specs/frontend/spec.md`
- `specs/09-frontend-architecture.md`
- `specs/03-message-parts.md`
- `specs/04-artifacts.md`
- `specs/10-agent-builder.md`
- `agent-conference-preview.png`

### UI 参考图总结

`agent-conference-preview.png` 展示的是 Agent-Conference 的目标桌面端工作台形态。它不是单页聊天窗口，也不是 landing page，而是一个三栏协作界面：

```text
左侧：产品导航 + 会话列表
中间：IM 式 Agent 群聊
右侧：Artifact 产物预览 / 编辑面板
```

从图中可以提炼出这些 UI 设计约束：

1. **左侧 Sidebar 是产品主导航**  
   顶部显示品牌 `Agent-Conference` 和副标题“多 Agent 协作平台”，下方是主导航：`对话`、`产物库`、`Agents`、`分析`。再往下是“新建对话”、搜索框和会话列表。会话项用圆形 Agent 缩写头像、标题、会话类型和 Agent 数量表达上下文。

2. **中间 ChatPanel 是 IM 群聊体验**  
   顶部 header 显示群聊标题、会话类型、Agent 数量，以及一组工具按钮。消息区按聊天流排列，用户消息靠右，Agent 消息靠左。Agent 消息包含头像、名称、时间、token 用量等元信息。

3. **MessagePart 需要结构化视觉**  
   图中消息不是纯 markdown：有折叠的“思考”块、正文、表格、代码片段、状态总结。P3 的 `MessagePartList` 必须支持不同 part 的差异化渲染，而不是把所有内容塞进一个大文本块。

4. **输入区固定在底部**  
   Composer 位于聊天区底部，包含 placeholder：“输入消息，@ 指定 Agent，Enter 发送，Shift+Enter 换行”，右侧有附件/安全/发送等图标按钮。聊天区内部滚动，不应让整个页面滚动导致输入框离开视口。

5. **右侧 ArtifactPreviewPanel 是第一屏核心，不是弹窗**  
   右侧面板占据约半屏宽度，顶部显示 artifact 标题、类型、版本和操作按钮；下面有 `预览 / 编辑` tab。预览区展示一个 web_app 的真实运行界面。P6 需要把产物预览做成常驻 panel，而不是只做 modal。

6. **Artifact 预览强调真实可检查状态**  
   参考图里的 web app 预览能看到完整页面、表单、筛选控件和空状态。这说明 artifact preview 不只是缩略图，而是可交互、可验证的沙箱运行区。

7. **整体视觉风格**  
   UI 以白色、浅灰边框、蓝紫强调色为主；按钮和卡片圆角较明显但仍偏工具型。布局密度较高，信息清晰分区，接近 Slack/Linear/IDE 工作台，而不是营销型大留白页面。

8. **Orchestrator 输出应像普通 Agent 消息一样存在**  
   图中 Orchestrator 消息包含折叠思考、总结表格和完成说明。P9 的计划、任务状态和聚合结果应嵌入聊天流，而不是跳到独立流程页。

MVP 页面结构：

```text
RootLayout
  AppShell
    Sidebar
      ConversationsTab
      ArtifactsTab
      AgentsTab
      SettingsButton
    ChatPanel
      ConversationHeader
      MessageTimeline
      PendingApprovalsStrip
      MessageComposer
    ArtifactPreviewPanel
```

关键组件：

- `MessagePartList`
- `TextPart`
- `ThinkingPart`
- `ToolActivityPart`
- `ArtifactRefPart`
- `DeployStatusPart`
- `ArtifactPreviewPanel`
- `CreateAgentDialog`
- `CreateConversationDialog`
- `SettingsDialog`
- `PendingWritesPanel`
- `PendingBashPanel`
- `DispatchPlanReviewCard`

## 10. 安全与沙箱

参考：

- `CLAUDE.md` 第 5 节
- `openspec/specs/platform-security/spec.md`
- `openspec/specs/tools/spec.md`
- `specs/07-tools.md`
- `specs/11-platform.md`

MVP 必须实现：

- workspace path containment。
- Windows/POSIX 平台差异。
- `fs_read` / `fs_write` / `bash` 的 effective cwd。
- sandbox mode 100MB / 1000 文件配额。
- banned command pattern。
- review mode pending write。
- key command pending bash approval。
- web app preview iframe `sandbox="allow-scripts"`，不允许 `allow-same-origin`。

## 11. 验收总标准

每个优先级都有自己的验收标准。MVP 总体验收：

1. `pnpm install` 后依赖可用。
2. `pnpm typecheck` 通过。
3. `pnpm lint` 通过。
4. `pnpm build` 通过。
5. 首次启动自动创建数据库和 seed agents。
6. 用户能创建会话、发送消息、看到 Mock agent 流式回复。
7. 用户能创建并预览 artifact。
8. 工具调用能在消息里显示 `tool_use` / `tool_result`。
9. 越权文件路径和危险命令会被拒绝。
10. 群聊 Orchestrator 的计划审批流程可手动跑通。

## 12. 风险清单

| 风险 | 影响 | 应对 |
|---|---|---|
| Next 16 API 与旧知识不同 | 路由/配置写法错误 | 每次框架层改动前读 `node_modules/next/dist/docs/` |
| SQLite native module build scripts 被 pnpm 忽略 | DB 运行时报 native binding 错 | P1 阶段处理 `pnpm approve-builds` 或 rebuild 文档 |
| Adapter/Tool 边界在 specs 中有历史漂移 | 实现与契约不一致 | 以 OpenSpec 当前契约和最新 numbered specs 为准 |
| Orchestrator 过早复杂化 | MVP 延误 | 先 Mock/基础 plan，再接真实 Custom adapter |
| 安全约束遗漏 | workspace 越权或危险命令 | P5 单独实现并测试 sandbox/security |
| 前端 reducer 状态漂移 | 流式 UI 不稳定 | StreamEvent reducer 做纯函数和单元测试 |

## 13. 不在本文档中直接实现的内容

本文档是路线图，不是代码实现。实际编码时按 `P0` 到 `P10` 分批推进；每个阶段如需新增依赖、修改 spec 契约或改变安全规则，必须先停下来确认。
