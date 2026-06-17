# P3 - 会话与消息

## 目标

实现用户侧聊天主流程：创建会话、选择 Agent、发送消息、持久化 `MessagePart[]`、广播用户消息，并根据会话模式决定 responder。

## 参考文件

- `openspec/specs/core-domain/spec.md`
- `openspec/specs/message-parts/spec.md`
- `openspec/specs/frontend/spec.md`
- `specs/01-core-entities.md`
- `specs/02-stream-events.md`
- `specs/03-message-parts.md`
- `specs/09-frontend-architecture.md`
- `AGENT_BACKEND.md` 第 1 章“消息入口链路”

## 范围

需要实现：

- `src/server/conversation-service.ts`
- `src/app/api/conversations/route.ts`
- `src/app/api/conversations/[id]/route.ts`
- `src/app/api/conversations/[id]/messages/route.ts`
- `src/components/sidebar.tsx`
- `src/components/chat-panel.tsx`
- `src/components/message-input.tsx`
- `src/components/message-parts.tsx`

## UI 组件级实现计划

### UI 参考图对齐

参考图：`agent-conference-preview.png`。

P3 的聊天 UI 应对齐参考图中的中间区域和左侧会话栏：

- 左侧 sidebar 顶部保留品牌区、设置、深色模式、折叠等 icon 操作位。
- 主导航包含 `对话`、`产物库`、`Agents`、`分析`，P3 先实现 `对话`，其他项可展示为占位入口。
- 会话列表项使用圆形缩写头像，例如 `OR`、`P小`，并显示“群聊 · 3 位 Agent”或“单聊 · 1 位 Agent”。
- Chat header 显示群聊标题，例如“UI 设计师 / 前端工程...”，副标题显示“群聊 · 3 位 Agent”。
- 消息区采用 IM 布局：用户消息靠右，Agent 消息靠左，Agent 消息带头像、名称、时间、token 用量。
- 输入框固定底部，placeholder 对齐参考图：“输入消息，@ 指定 Agent，Enter 发送，Shift+Enter 换行”。
- 输入框右侧预留附件、审批/安全、发送 icon 按钮。

### 页面区域

P3 的 UI 目标是先做出可用的聊天工作台骨架。页面不是 landing page，而是打开即进入工作区。

```text
AppShell
  Sidebar
    BrandHeader
    SidebarTabs
    ConversationSearchBox
    ConversationList
    AgentRosterSummary
    NewConversationButton
  ChatPanel
    ConversationHeader
    MessageTimeline
      MessageGroup
      MessageBubble
      MessagePartList
    MessageComposer
```

### `AppShell`

职责：

- 负责三栏基础布局：左侧会话栏、中间聊天区、右侧预留给 P6 artifact panel。
- 初始化 P2 的 `StreamProvider`。
- 从 store 读取当前 conversation id。

状态来源：

- `appStore.conversations`
- `appStore.activeConversationId`
- `appStore.connectionStatus`

实现要点：

- 使用固定高度 `min-h-screen`，聊天区内部滚动，避免整页滚动打乱输入框位置。
- 左侧栏宽度固定或 responsive clamp，例如 `280px-340px`。
- 移动端 MVP 可先降级为单列，但组件结构不要阻碍后续 drawer/sidebar。

验收：

- 没有 conversation 时显示空态。
- 选中 conversation 后中间区域切换。

### `Sidebar`

职责：

- 展示会话列表。
- 提供新建会话入口。
- 展示当前连接状态。
- 后续容纳 artifacts/agents/settings tabs，但 P3 只实现 conversations tab。
- 对齐参考图中的左侧产品导航密度和信息层级。

子组件：

| 组件 | 职责 |
|---|---|
| `BrandHeader` | 显示 Agent-Conference、产品副标题和顶栏图标入口 |
| `SidebarTabs` | 预留 conversations/artifacts/agents 三个 tab |
| `ConversationList` | 渲染会话摘要列表 |
| `ConversationListItem` | 标题、最后消息、未读/运行中状态 |
| `NewConversationButton` | 打开创建会话弹窗 |
| `ConversationSearchBox` | 搜索会话，MVP 可只做输入框占位 |

交互：

- 点击会话项设置 `activeConversationId`。
- 新建按钮打开 `CreateConversationDialog`。
- 当前会话高亮。

参考：

- `specs/09-frontend-architecture.md`
- `openspec/specs/frontend/spec.md`

### `CreateConversationDialog`

职责：

- 创建单聊或群聊。
- 选择参与 Agent。
- 选择 workspace 模式，MVP 默认 sandbox。
- 选择文件写入审批模式，MVP 默认 review 或 auto 由产品决定。

表单字段：

| 字段 | 类型 | 规则 |
|---|---|---|
| `title` | input | 可为空，空时服务端生成 |
| `mode` | segmented control | `single` / `group` |
| `agentIds` | checkbox list | single 必须 1 个，group 至少 2 个 |
| `workspaceMode` | segmented control | MVP 先只开放 sandbox |
| `fsWriteApprovalMode` | segmented control | `auto` / `review` |

API：

- `POST /api/conversations`

验收：

- 表单错误在提交前展示。
- 创建成功后自动选中新会话。

### `ConversationHeader`

职责：

- 展示当前会话标题、模式、参与 Agent。
- 展示运行状态，例如有 active run 时显示“运行中”。
- 提供后续 pin/search/settings 入口占位。
- 右侧放置与参考图类似的工具按钮组，例如上下文、artifact panel、文件、列表、添加 Agent。

状态来源：

- `appStore.conversations[activeConversationId]`
- `appStore.agents`
- `appStore.agentRuns`

验收：

- 单聊显示 Agent 名称。
- 群聊显示参与 Agent 数量和 Orchestrator 标识。
- 标题过长时省略，但副标题仍可读。

### `MessageTimeline`

职责：

- 渲染当前会话消息。
- 新消息到来时自动滚动到底部，用户手动向上阅读时不要强制抢滚动。
- 支持 streaming 状态。

子组件：

| 组件 | 职责 |
|---|---|
| `MessageGroup` | 按 message/agent 分组，显示头像、名字、时间 |
| `MessageBubble` | 根据 role 渲染用户/agent/system 样式 |
| `MessageStatusBadge` | streaming/complete/error/aborted |
| `MessagePartList` | 渲染结构化 parts |
| `AgentMessageMeta` | 显示 Agent 名称、时间、token 用量 |
| `UserMessageMeta` | 显示用户标识和时间 |

实现要点：

- 不从 markdown 解析工具或 artifact。
- `message.parts` 顺序即渲染顺序。
- streaming message 的 part 可能不完整，要能显示半截文本。

验收：

- 用户消息、Agent 消息视觉区分清楚。
- `part.delta` 到达后文本增量显示。
- error message 可见。
- Agent 长回复在卡片内保持可读，不撑破聊天列。

### `MessagePartList`

职责：

- 根据 `MessagePart.type` 分发渲染。
- P3 至少支持 `text`、`thinking`、`tool_use`、`tool_result`、`artifact_ref` 的占位。

组件映射：

| part type | 组件 | MVP 行为 |
|---|---|---|
| `text` | `TextPart` | markdown-like 纯文本换行显示，暂不启用 raw HTML |
| `thinking` | `ThinkingPart` | 默认折叠，样式参考图中虚线边框“思考”块 |
| `tool_use` | `ToolUsePart` | 显示工具名和参数 JSON |
| `tool_result` | `ToolResultPart` | 显示结果/错误 |
| `artifact_ref` | `ArtifactRefPartPlaceholder` | P6 前显示可点击占位或禁用态 |
| `code` | `CodePart` | 行内或块级代码使用 monospace 背景 |

参考：

- `specs/03-message-parts.md`
- `skills/add-message-part.md`

### `MessageComposer`

职责：

- 输入文本。
- 选择 @ Agent。
- 发送消息。
- 显示发送中/禁用状态。

子组件：

| 组件 | 职责 |
|---|---|
| `MentionPicker` | 从当前会话 Agent 中选择 mentions |
| `ComposerTextarea` | 自适应高度输入 |
| `SendButton` | 发送 |
| `ComposerToolbar` | 附件、审批/安全、slash command 后续入口 |

交互：

- Enter 发送，Shift+Enter 换行。
- 空文本且无附件时禁用发送。
- 发送后清空输入，但不乐观创建 agent 消息。

API：

- `POST /api/conversations/[id]/messages`

验收：

- 单聊无需 mentions。
- 群聊 mentions 能传 `mentionedAgentIds`。
- 发送失败时保留用户输入。
- Composer 始终固定在 chat panel 底部。

## Responder 规则

参考 `AGENT_BACKEND.md` 中 `decideResponders()`：

| 场景 | responder |
|---|---|
| 单聊 | 会话里的唯一 Agent |
| 群聊有 @ | 被 @ 的 Agent |
| 群聊无 @ | 群里的 Orchestrator |
| 群聊无 Orchestrator | 无自动回复 |

## 任务拆分

1. 实现 conversation CRUD。
2. 实现 send message API，body 用 zod 校验。
3. 用户消息转成 `parts: [{ type: 'text', content }]`。
4. 持久化用户消息后发布 `message.added`。
5. 实现 responder 选择。
6. 暂时用 P4 的 AgentRunner 接口启动 run。
7. UI 展示会话列表、消息列表、输入框。
8. 实现基础 `MessagePart` 渲染：text、thinking、tool_use、tool_result、artifact_ref。

## 验收标准

- 用户能创建单聊和群聊。
- 用户能发送文本消息。
- 用户消息以 `MessagePart[]` 存 DB。
- 发送消息返回 `202 Accepted` 和 run ids。
- 第二个客户端能通过 SSE 收到 `message.added`。
- 群聊 responder 规则符合文档。

## 风险

- 不要从 markdown 中反向解析 @；mentions 应作为结构化 agent id 传入。
- Message withdraw/edit/regenerate 会影响 artifact 删除策略，MVP 可先只做基础发送。
