# 前端与 UI 完整目标及优先级实施计划

## 1. 文档目标

本文档基于当前 Agent-Conference 前端代码、`specs/09-frontend-architecture.md`、`specs/10-agent-builder.md` 与对应 OpenSpec，重新定义前端与 UI 的完整目标、当前差距、优先级、组件级任务、状态结构、接口依赖、测试矩阵和验收标准。

目标不是继续堆叠页面，而是把目前已经存在的 Sidebar、Chat、Artifact、Agent Builder、审批、搜索和上下文面板串成一套完整、稳定、可重复使用的多 Agent 协作工作台。

最终用户应能在一个连续工作流中完成：

```text
创建/选择会话
  -> 配置群聊 Agent
  -> 发送消息、附件、@mention 或引用
  -> 审核 Orchestrator 计划
  -> 观察多 Agent 执行和审批工具操作
  -> 打开 Workspace 文件、Diff 和 Artifact
  -> 修改、保存、部署并比较版本
  -> 搜索历史、Pin 关键信息
  -> 在桌面和窄屏下稳定使用
```

## 2. 当前范围

本计划包含：

- Next.js 16 App Router 前端。
- React 19。
- Zustand + Immer Store。
- SSE 实时事件消费。
- Web 本地运行。
- DeepSeek Custom Agent 的产品 UI。
- 单聊和多 Agent 群聊。
- Workspace、Artifact、部署、审批、搜索和上下文管理。

本计划不包含：

- Electron 专用 UI。
- Capacitor 移动 App。
- Claude Code/Codex SDK 的完整配置体验。
- 外部 MCP 管理界面。
- 多用户、登录和权限系统。

Claude Code/Codex 可以继续显示为禁用或规划中，但不能阻塞 DeepSeek-only Web 产品完成度。

## 3. 规格和代码依据

### 规格

- `openspec/specs/frontend/spec.md`
- `openspec/specs/agent-builder/spec.md`
- `openspec/specs/orchestrator/spec.md`
- `openspec/specs/artifacts/spec.md`
- `openspec/specs/conversation-context/spec.md`
- `openspec/specs/message-search/spec.md`
- `specs/02-stream-events.md`
- `specs/03-message-parts.md`
- `specs/04-artifacts.md`
- `specs/06-orchestrator-flow.md`
- `specs/09-frontend-architecture.md`
- `specs/10-agent-builder.md`
- `specs/13-conversation-context.md`
- `specs/16-message-search.md`
- `specs/17-orchestrator-plan-review.md`

### 当前主要代码

- `src/components/app-shell.tsx`
- `src/components/sidebar.tsx`
- `src/components/chat-panel.tsx`
- `src/components/message-input.tsx`
- `src/components/message-parts.tsx`
- `src/components/dispatch-progress.tsx`
- `src/components/pending-approval-panel.tsx`
- `src/components/pending-question-card.tsx`
- `src/components/artifact-panel.tsx`
- `src/components/artifact-library.tsx`
- `src/components/workspace-file-browser.tsx`
- `src/components/context-stats-panel.tsx`
- `src/components/global-search.tsx`
- `src/components/create-agent-dialog.tsx`
- `src/components/settings-dialog.tsx`
- `src/stores/app-store.ts`
- `src/stores/store-types.ts`
- `src/stores/selectors.ts`
- `src/stores/reducers/`

## 4. 当前完成度

当前前端/UI 综合完成度约为：

> **78%**

### 分项判断

| 模块 | 完成度 | 当前状态 |
|---|---:|---|
| 应用 Shell 与 Sidebar | 88% | 主布局、折叠、导航、搜索、设置、主题已存在 |
| 会话列表与创建 | 85% | 创建、切换、搜索、重命名、归档、删除基本存在 |
| Chat 消息流 | 82% | 文本、思考、工具、Artifact、部署、调度状态已渲染 |
| Composer 输入区 | 60% | 文本和 @Agent 可用；附件、审批模式、引用未闭环 |
| Orchestrator 计划审核 | 55% | 进度展示可用；结构化编辑和完整审批 UI 不足 |
| Pending 决策 | 85% | 写入、Bash、问题和计划状态已有基础组件 |
| Workspace 文件体验 | 55% | 右侧文件树和文本预览已有；Tab/编辑/Diff 工作流缺失 |
| Artifact 工作区 | 82% | 预览、保存、版本、部署主体已存在 |
| Agent Builder | 86% | DeepSeek Custom、工具配置和快捷创建已有 |
| 搜索与上下文 | 88% | 全局搜索、跳转、上下文统计和压缩已存在 |
| 响应式布局 | 45% | 主要面向桌面固定三栏 |
| Dark Mode/视觉一致性 | 70% | 主体支持，但部分组件仍硬编码浅色 |
| 可访问性 | 55% | 基础按钮 title 存在，键盘、焦点和语义仍不足 |
| 组件与交互测试 | 50% | Store 测试较强，UI 工作流测试不足 |

## 5. 当前已经完成的能力

以下内容不应再作为“从零实现”的任务：

1. Sidebar 四个主入口：对话、产物库、Agents、分析。
2. Sidebar 展开/折叠。
3. Dark Mode 开关。
4. 设置对话框。
5. 会话创建、选择、搜索、重命名、归档和删除。
6. Agent 列表和创建/编辑对话框。
7. DeepSeek Custom Agent provider/model/key/base URL/tool 配置。
8. Chat 消息列表。
9. Markdown 消息渲染。
10. Thinking 折叠。
11. Tool Use/Tool Result 卡片。
12. Artifact 引用卡片。
13. Deployment 状态卡片。
14. Orchestrator 调度进度卡。
15. Pending write、Bash、问题和计划状态。
16. Artifact 预览、保存、版本历史和对比。
17. Workspace 文件树和文本预览。
18. 全局消息搜索和消息跳转。
19. 上下文统计和手动压缩。
20. SSE → Store reducer → UI 的基本链路。
21. Store 实体 normalize。
22. Artifact Panel 宽度调整。

## 6. 核心设计目标

### 6.1 工作台而不是聊天演示

主界面必须同时支持：

- 对话沟通。
- 多 Agent 状态观察。
- 用户审批。
- 文件和 Artifact 检查。
- 版本比较。
- 部署操作。

不能让用户频繁离开当前会话或依赖浏览器新窗口完成核心操作。

### 6.2 所有可见按钮必须有完整行为

按钮不允许只有图标和 hover 状态，却没有：

- `onClick`。
- Loading。
- Error。
- Success。
- Disabled 原因。

没有准备好的能力应隐藏或明确禁用，不能伪装成可用功能。

### 6.3 Store 只保存跨组件共享状态

应进入 Store：

- 当前会话。
- 当前右栏模式。
- 文件 Tab。
- 引用目标。
- Pending Attachment。
- Pending Plan。
- 搜索结果。
- SSE 实体。

应保留组件本地：

- Hover。
- Tooltip 开关。
- 简单 Dialog 开关。
- 单个表单尚未保存的 draft。
- 临时复制成功状态。

### 6.4 API 操作必须有一致反馈

任何写操作应统一具备：

```text
idle
  -> submitting
  -> success | error
```

用户至少能知道：

- 操作正在进行。
- 操作成功。
- 操作为什么失败。
- 是否可以重试。

### 6.5 响应式不是简单缩窄

桌面：

```text
Sidebar | Chat | Right Workspace
```

窄屏：

```text
Chat
  + Sidebar Drawer
  + Workspace Drawer
```

不能把三栏压缩到每栏无法使用。

## 7. 优先级总览

| 优先级 | 主题 | 完成后的结果 |
|---|---|---|
| P0 | 修复空操作和状态语义错误 | 所有主界面入口可信可用 |
| P1 | Composer 与消息工作流 | 消息、附件、引用、Pin、编辑形成闭环 |
| P2 | Orchestrator 计划审核 UI | 用户能结构化审核和修改计划 |
| P3 | Workspace 文件与 Diff 工作台 | 文件、审批 Diff 和聊天形成统一 Tab 工作流 |
| P4 | Artifact、部署与 Agent Builder 补全 | 产物交付和 Agent 配置体验完整 |
| P5 | 响应式布局与移动 Web | 小屏和窄窗口可以正常使用 |
| P6 | 视觉系统、Dark Mode 与可访问性 | UI 统一、稳定、键盘可用 |
| P7 | 测试、性能和发布验收 | 前端行为可持续回归 |

---

## P0 - 修复空操作和状态语义错误

### 目标

先修复用户一眼就能遇到的无效入口、错误状态复用和不一致行为，保证界面中的每个主要控件都可信。

### 现状证据

`src/components/chat-panel.tsx` 中：

- “工作区文件”按钮仅设置模式。
- “文件”按钮没有行为。
- “添加 Agent”按钮没有行为。

`src/components/sidebar.tsx` 中：

- 会话置顶通过向 `pinnedMessageIds` 写入 `"__pinned__"` 实现。
- `pinnedMessageIds` 原本表示消息 Pin，不应承担会话置顶。

### P0.1 Header 工具栏重构

创建明确的 Header action：

```typescript
interface ChatHeaderActions {
  openWorkspaceFiles(): void;
  openArtifactWorkspace(): void;
  openFileLibrary(): void;
  openAgentManager(): void;
  openContextStats(): void;
}
```

组件建议：

- `ChatHeader`
- `ChatHeaderActions`
- `ConversationAgentStack`
- `ConnectionBadge`

不要继续把全部 Header 逻辑留在 `chat-panel.tsx`。

### P0.2 工作区按钮行为

点击“工作区文件”：

1. 设置 `rightPanelMode="files"`。
2. 设置 `rightPanelOpen=true`。
3. 如果当前没有 conversation，则 disabled。
4. 已经打开时再次点击可关闭，或保持打开；选定一个一致规则。
5. 图标具有 active 状态。

点击 Artifact：

1. 设置 `rightPanelMode="artifact"`。
2. 打开右栏。
3. 没有 active artifact 时显示 Artifact Library/空状态。

### P0.3 文件按钮

“文件”按钮必须选择一种明确语义：

方案 A，推荐：

- 打开 `FileLibraryDialog`。
- 显示当前会话附件。
- 支持上传、查看、删除和插入 Composer。

方案 B：

- 如果暂不实现 File Library，删除这个重复按钮。

不能保留无行为图标。

### P0.4 添加 Agent

点击“添加 Agent”：

- 打开 `ConversationAgentManagerDialog`。
- 显示当前 Agent 和 Agent Library。
- 支持为群聊增加/移除 Agent。
- 单聊增加第二个 Agent 时，明确是否转换为群聊。
- Orchestrator 最多一个。

需要的 API 契约：

```http
PATCH /api/conversations/:id
{
  "agentIds": ["..."],
  "mode": "group"
}
```

如果当前后端 PATCH 不支持，应在 P0 标记为前后端联合依赖。

### P0.5 会话置顶模型

禁止继续使用：

```typescript
pinnedMessageIds: ["__pinned__"]
```

推荐为 Conversation 增加：

```typescript
isPinned: boolean
```

或：

```typescript
pinnedAt: number | null
```

推荐 `pinnedAt`，可以稳定排序多个置顶会话。

迁移时：

1. 清理历史 `"__pinned__"`。
2. `pinnedMessageIds` 只保存真实 Message ID。
3. Sidebar 排序使用 `pinnedAt`。
4. PinnedMessagesBar 使用 `pinnedMessageIds`。

### P0.6 异步状态

Header、Sidebar 上的写操作统一增加：

- submitting。
- disabled。
- error message。
- rollback。

目前许多 `fetch()` 没有检查 `response.ok`，需要建立轻量 action helper：

```typescript
async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T>
```

或使用当前 API helper 模式，避免每个组件复制错误处理。

### P0 主要文件

- `src/components/chat-panel.tsx`
- `src/components/sidebar.tsx`
- `src/components/app-shell.tsx`
- `src/stores/store-types.ts`
- `src/stores/app-store.ts`
- `src/shared/types.ts`
- `src/app/api/conversations/[id]/route.ts`

### P0 验收标准

- Header 不存在无行为按钮。
- 文件和 Artifact 按钮能打开正确右栏。
- 添加 Agent 有完整 Dialog 或明确隐藏。
- 会话置顶不再污染 `pinnedMessageIds`。
- API 失败时 UI 不会错误地更新成功状态。
- 所有图标按钮有 tooltip、active 和 disabled 状态。

---

## P1 - Composer 与消息工作流

### 目标

把 Composer 从“文本 + Agent 按钮”升级为完整的协作输入区，接通附件、审批模式、引用、编辑、撤回和消息 Pin。

### P1.1 Composer 状态分桶

当前 `composerDraft` 是全局字符串，切换会话会串 draft。

改为：

```typescript
composerDraftByConversation: Record<string, string>;
mentionedAgentIdsByConversation: Record<string, string[]>;
```

或让 mention 保持组件本地，但 conversation 切换时必须重置。

Store actions：

```typescript
setComposerDraft(conversationId, draft)
clearComposer(conversationId)
setReplyTarget(conversationId, messageId)
addPendingAttachment(conversationId, attachment)
removePendingAttachment(conversationId, attachmentId)
```

### P1.2 附件上传

Composer 附件按钮应：

1. 打开文件选择器。
2. 调用附件上传 API。
3. 显示上传中 chip。
4. 成功后加入 `pendingAttachmentsByConversation`。
5. 发送消息时提交 attachment IDs。
6. 发送成功后清空当前 conversation 的 pending attachments。
7. 失败时保留可重试状态。

组件建议：

- `AttachmentPickerButton`
- `PendingAttachmentList`
- `PendingAttachmentChip`
- `FileLibraryDialog`

状态：

```typescript
interface PendingAttachmentDraft {
  localId: string;
  attachmentId: string | null;
  fileName: string;
  size: number;
  mimeType: string;
  status: "uploading" | "ready" | "error";
  error: string | null;
}
```

### P1.3 Auto/Review 审批模式

当前 Shield 图标没有行为。

目标：

- 使用 segmented control 或明确菜单。
- 显示当前会话 `fsWriteApprovalMode`。
- `auto`：允许安全写入自动执行。
- `review`：写入进入审批队列。
- 更改后 PATCH conversation。
- UI 上始终可见当前模式。

不要仅用一个没有状态的盾牌图标。

### P1.4 引用回复

Store 已有 `replyTargetByConversation`，但 UI 未接入。

消息 hover actions 增加 Reply：

1. 设置 reply target。
2. Composer 顶部显示 `ReplyPreview`。
3. 显示发送者、文本摘要和关闭按钮。
4. 发送时提交 `parentMessageId`。
5. 消息 Bubble 渲染 `QuotedMessage`。
6. 点击引用跳转到原消息并短暂高亮。

### P1.5 消息 Pin

每条 Message 的操作菜单增加：

- Pin。
- Unpin。

调用已有消息 Pin API。

新增：

```text
PinnedMessagesBar
  - 显示当前会话 Pin 数量
  - 默认折叠
  - 展开后显示消息摘要
  - 点击跳转
  - 支持取消 Pin
```

PinnedMessagesBar 放在消息列表顶部，而不是 Sidebar。

### P1.6 消息编辑

当前只有撤回路径。

目标：

- 最后一条用户消息支持 Edit。
- 点击后 Bubble 进入 inline editor。
- Enter 保存并重发。
- Shift+Enter 换行。
- Escape 取消。
- 保留 parentMessageId、mentions 和 attachment IDs。
- 编辑时中止相关运行并删除旧派生结果。

如果后端尚无 edit API，需补：

```http
POST /api/messages/:id/edit
```

### P1.7 撤回反馈

撤回操作应增加：

- Loading。
- 错误提示。
- 防重复点击。
- 删除后保持滚动位置合理。

### P1.8 乐观用户消息

Spec 09 定义了 optimistic message，但当前 Store `sendMessage` 直接等待 API。

补：

```typescript
addLocalUserMessage()
replaceLocalMessageId()
removeLocalMessageOnError()
```

要求：

- 点击发送立即出现用户 Bubble。
- 服务端返回后替换真实 ID。
- SSE 重复消息幂等。
- 失败时 Bubble 显示重试，不直接消失。

### P1.9 Composer 键盘与输入法

处理：

- IME composition 时 Enter 不发送。
- Shift+Enter 换行。
- Escape 退出 reply/edit/revise。
- 发送过程中避免重复提交。
- Draft 切会话不丢失。

### P1 主要文件

- `src/components/message-input.tsx`
- `src/components/chat-panel.tsx`
- 新增 `src/components/message-actions.tsx`
- 新增 `src/components/pinned-messages-bar.tsx`
- 新增 `src/components/reply-preview.tsx`
- 新增 `src/components/quoted-message.tsx`
- 新增 `src/components/pending-attachment-list.tsx`
- `src/stores/store-types.ts`
- `src/stores/app-store.ts`
- `src/stores/selectors.ts`

### P1 验收标准

- 附件可以上传、移除并随消息发送。
- Auto/Review 可切换并保持会话级状态。
- 可以引用一条消息并跳回原消息。
- 可以 Pin/Unpin 消息。
- PinnedMessagesBar 正确显示。
- 最后一条用户消息可以编辑和撤回。
- 发送消息立即出现乐观 Bubble。
- 切换会话后 draft、附件和 reply 不串线。

---

## P2 - Orchestrator 计划审核 UI

### 目标

把当前只读 `DispatchProgress` 扩展为“计划审核 + 执行进度 + 结果诊断”的完整组件。

### P2.1 组件拆分

建议拆分：

```text
DispatchCard
  ├── PlanReviewHeader
  ├── EditableTaskList
  │   └── EditableTaskRow
  ├── PlanReviewActions
  ├── DispatchExecutionSummary
  └── DispatchTaskStatusList
```

状态模式：

```typescript
type DispatchCardMode =
  | "review"
  | "revising"
  | "executing"
  | "complete"
  | "failed";
```

### P2.2 结构化任务编辑

每个任务支持编辑：

- Task title。
- Task prompt/description。
- Agent assignment。
- `dependsOn`。
- `inputs`。
- `expectedOutputs`。
- `acceptanceCriteria`。
- `targetPaths`。
- `requiredCommands`。
- `maxAttempts`。

使用适合的数据控件：

- Agent：Select/Menu。
- Dependencies：多选。
- maxAttempts：Stepper/Input。
- acceptance criteria：可增删列表。
- target paths：Tag input。

### P2.3 实时客户端校验

批准前校验：

1. task ID 唯一。
2. Agent 存在且属于会话。
3. 不允许选择 Orchestrator 自己作为 worker。
4. dependsOn 引用存在。
5. 不允许自依赖。
6. 无循环依赖。
7. expected output key 唯一。
8. acceptance criteria 非空。

客户端校验只改善体验，服务端仍为最终权威。

### P2.4 审核操作

必须提供：

- Approve。
- Reject。
- Revise。

Approve：

- 提交完整 edited plan。
- Loading。
- 成功后进入 executing。

Reject：

- 可选拒绝原因。
- 进入 rejected。

Revise：

- 可以继续使用 Composer 自然语言 revise。
- Card 内明确显示“等待 Orchestrator 修订”。

### P2.5 执行进度

执行模式显示：

- 总任务数。
- 完成/失败/跳过数。
- 当前 wave。
- Agent。
- attempt。
- dependencies。
- expected outputs。
- acceptance 状态。
- 错误摘要。

### P2.6 Recovery 展示

当 Recovery 发生：

- 显示“原计划”和“修复计划”关系。
- 标记哪些任务复用完成结果。
- 标记哪些任务重新执行。
- 不把 Recovery Task 混成普通初始 Task。

### P2.7 Aggregate 结果

卡片最终状态：

- 全部完成。
- 部分完成。
- Recovery 后完成。
- 仍有失败。
- 用户中止。

不要只根据 completeCount 展示成功。

### P2 主要文件

- `src/components/dispatch-progress.tsx`
- 新增 `src/components/dispatch-plan-editor.tsx`
- 新增 `src/components/dispatch-task-editor.tsx`
- 新增 `src/components/dispatch-review-actions.tsx`
- `src/stores/store-types.ts`
- `src/stores/reducers/dispatch-events.ts`
- `src/stores/selectors.ts`

### P2 验收标准

- Pending Plan 可以在卡片内结构化编辑。
- 可以批准、拒绝和自然语言修订。
- 非法依赖在提交前可见。
- 执行中显示 task、Agent、attempt 和 output。
- Recovery Plan 与初始 Plan 可区分。
- 失败任务不会被 UI 显示为整体成功。

---

## P3 - Workspace 文件与 Diff 工作台

### 目标

把当前右栏文件树升级为完整的文件工作区，并接通 Spec 09 已存在但未消费的 file tab 状态。

### P3.1 Store actions

当前 Store 有：

- `openFilesByConversation`
- `activeTabByConversation`

但没有完整 actions。

新增：

```typescript
openConversationFile(conversationId, path)
closeConversationFile(conversationId, path)
setActiveConversationTab(conversationId, tabId)
openPendingWriteDiff(conversationId, pendingId)
closeConversationTab(conversationId, tabId)
```

Tab ID 规范：

```text
chat
file:<normalized-path>
diff:<pending-write-id>
artifact:<artifact-id>  // 可选
```

### P3.2 中央 Tab Bar

ChatPanel 增加：

```text
对话 | package.json × | src/app/page.tsx × | Diff: page.tsx ×
```

要求：

- Tab 宽度稳定。
- 超出时横向滚动或 overflow menu。
- 文件名和路径 tooltip。
- 关闭 active tab 后选择相邻 tab。
- 每个 conversation 独立保存 tabs。

### P3.3 Workspace File Browser

文件树增强：

- 当前展开目录状态。
- 当前选择文件。
- Refresh。
- 加载/空/error。
- 文件大小。
- 文件类型图标。
- 点击文件默认打开中央 File Tab，而不是仅在右栏 `<pre>`。
- 右栏可保留 quick preview，但中央 Tab 是主要检查区。

### P3.4 File Viewer

`FileTab` 支持：

- 文本文件语法高亮。
- 行号。
- 复制。
- 搜索。
- 自动换行开关。
- 截断提示。
- 重新加载。

第一版可以只读。

编辑能力应单独决定：

- 若允许编辑，必须有 dirty 状态、Save、冲突检测和审批规则。
- 不要直接把 `<textarea>` 当正式编辑器。

### P3.5 Pending Write Diff

审批卡片点击“查看更改”：

1. 打开 `diff:<pending-id>` Tab。
2. 展示 path、Agent、reason。
3. 展示 before/after line diff。
4. Approve/Reject 保持可见。
5. 审批完成后 Tab 进入 resolved 状态或自动关闭。

已有 `file-diff-view.tsx` 应成为统一 Diff 渲染组件。

### P3.6 文件变化同步

Agent 写文件后：

- 文件树需要刷新。
- 已打开文件显示“内容已变化”。
- 用户可以 reload。

第一版可在以下事件触发：

- `fs_write.resolved`。
- Run end。
- 用户手动 Refresh。

### P3.7 Resize

Workspace File Browser 和 Artifact Panel 共用 right panel width。

需要：

- Resize handle。
- Min/max。
- 窄窗口自动限制。
- 宽度持久化到 localStorage，可选。

### P3 主要文件

- `src/components/workspace-file-browser.tsx`
- `src/components/chat-panel.tsx`
- 新增 `src/components/conversation-tab-bar.tsx`
- 新增 `src/components/file-tab.tsx`
- 新增 `src/components/pending-write-diff-tab.tsx`
- `src/components/file-diff-view.tsx`
- `src/stores/store-types.ts`
- `src/stores/app-store.ts`

### P3 验收标准

- 文件树点击文件会打开中央 Tab。
- 多个文件可同时打开和关闭。
- 每个会话有独立 Tab 状态。
- Pending Write 可以在 Diff Tab 审批。
- 文件被 Agent 修改后 UI 能提示刷新。
- 右栏宽度可调整且不挤坏 Chat。

---

## P4 - Artifact、部署与 Agent Builder 补全

### 目标

完成从 Agent 产出到用户检查、修改、版本比较和部署的交付闭环，同时让 Agent Builder 对 DeepSeek-only 范围清晰可靠。

### P4.1 Artifact 空状态

右栏没有 active artifact 时显示：

- 当前会话最近 Artifact。
- 类型筛选。
- 创建 Agent。
- 更新时间。
- 点击打开。

不要只显示空白或“请选择产物”。

### P4.2 Artifact Loading/Error

统一状态：

```typescript
type ArtifactViewStatus = "idle" | "loading" | "ready" | "saving" | "error";
```

需要：

- 404 墓碑。
- Retry。
- 保存失败错误。
- 部署失败错误。
- 版本加载失败。

### P4.3 Deploy Candidates 修复

当前候选卡直接打开 Artifact preview，不是正式部署。

目标：

1. 调用确定性部署 API。
2. 显示部署中。
3. 成功后渲染 Deployment Card。
4. 支持打开和复制 URL。
5. 失败时显示错误。

### P4.4 Deployment Card

完整显示：

- Local preview / external publish。
- Status。
- Public URL。
- Local fallback。
- Source download。
- Container download。
- Copy。
- Open。
- Retry deployment。

### P4.5 Artifact 编辑

Document：

- 编辑 Markdown。
- Dirty 状态。
- Save。
- Save as version。

Web App：

- 文件列表。
- Entry 文件。
- 代码查看。
- Preview。
- 保存新版本。

PPT：

- Slide 导航。
- 缩略图。
- 当前 Slide。
- 空状态和错误。

### P4.6 Version Compare

需要：

- Base version。
- Target version。
- 交换版本。
- 文本 diff。
- Web App 文件级 diff。
- 版本元数据。
- 从历史恢复为新版本，可选。

### P4.7 Agent Builder

DeepSeek-only 目标：

- 默认 Custom。
- 默认 DeepSeek。
- 默认 `deepseek-chat`。
- Claude/Codex 隐藏或明确 disabled。
- 不显示误导性的可用 SDK 配置。

### P4.8 Agent 快捷创建

Quick create 应：

1. 生成 draft。
2. 展示生成依据。
3. 展示默认假设。
4. 用户确认工具权限。
5. 再保存。

不要从一句描述直接无审查写入 Agent。

### P4.9 工具权限摘要

用清晰分组：

- 只读。
- 文件写入。
- 命令执行。
- Artifact。
- 部署。
- 用户交互。

危险权限使用显式提示，不只是 checkbox。

### P4 主要文件

- `src/components/artifact-panel.tsx`
- `src/components/artifact-library.tsx`
- `src/components/artifact-version-compare.tsx`
- `src/components/message-parts.tsx`
- `src/components/ppt-preview.tsx`
- `src/components/create-agent-dialog.tsx`
- `src/components/agents-panel.tsx`

### P4 验收标准

- Artifact 空状态可以直接浏览当前会话产物。
- Deploy Candidate 调用正式部署 API。
- Artifact 保存和部署错误可见。
- 版本比较覆盖文档和 Web App。
- DeepSeek Agent Builder 不暴露误导的 SDK 入口。
- 工具权限按风险清晰分组。

---

## P5 - 响应式布局与窄屏 Web

### 目标

让应用在 1280px、1024px、768px 和 390px 宽度下都能完成核心操作。

### P5.1 Breakpoints

建议：

```text
>= 1280:
  三栏同时显示

1024-1279:
  Sidebar 可折叠
  Right Panel 覆盖或压缩显示

768-1023:
  Sidebar Drawer
  Chat 主区
  Right Panel Drawer

< 768:
  单栏 Chat
  顶部按钮打开 Drawer/Sheet
```

### P5.2 Sidebar Drawer

窄屏：

- 默认隐藏。
- Header 菜单按钮打开。
- 选择会话后自动关闭。
- 支持 Esc。
- 支持 backdrop。
- 焦点锁定。

### P5.3 Right Workspace Drawer

窄屏：

- 文件和 Artifact 使用全高 Drawer。
- 可在文件/Artifact 间切换。
- 保留当前选择。
- 关闭后回到 Chat。

### P5.4 Header 压缩

窄屏 Header：

- 会话标题。
- Menu。
- Workspace。
- 更多菜单。

不在一行塞入所有按钮。

### P5.5 Composer

窄屏：

- Agent chips 横向滚动或折叠菜单。
- textarea 不被键盘和工具栏挤压。
- Pending attachments 可横向滚动。
- Send 保持触达。

### P5.6 Message

- 长代码块不撑破页面。
- 表格横向滚动。
- Artifact card 不溢出。
- Dispatch task 内容自动换行。
- 长文件路径可复制并截断显示。

### P5.7 Dialog

- Create Agent、Settings、Plan Editor 在窄屏使用全屏 Dialog/Sheet。
- 底部 action 固定。
- 内容独立滚动。

### P5 验收标准

- 390px 宽度可以创建会话、发消息、审批和打开 Artifact。
- 768px 不出现三栏互相挤压。
- 所有 Dialog 内容可滚动且按钮可触达。
- 没有横向页面级溢出。
- 长文本、路径和按钮不重叠。

---

## P6 - 视觉系统、Dark Mode 与可访问性

### 目标

统一视觉语言，减少硬编码样式，并达到基本键盘和屏幕阅读器可用性。

### P6.1 Token 化

当前存在较多：

- `bg-white`
- `text-slate-*`
- `border-slate-*`
- `#4264ff`

应逐步改为 CSS variables：

```text
--background
--foreground
--surface
--surface-muted
--border
--primary
--primary-foreground
--destructive
--warning
--success
--muted
```

不要求一次重写全部 Tailwind，但新增和核心组件优先使用 token。

### P6.2 Dark Mode

逐项检查：

- Header。
- Composer。
- Dispatch Card。
- Pending Approval。
- Context Stats。
- Search。
- Dialog。
- Artifact。
- Workspace。
- Tool Card。

当前很多组件只在 AppShell 切背景，内部仍固定白色。

### P6.3 Dialog 替换 confirm

替换原生：

```typescript
confirm(...)
```

使用统一 `ConfirmDialog`：

- 标题。
- 说明。
- 危险操作色。
- Cancel。
- Confirm。
- Loading。
- 错误。

用于：

- 删除 Conversation。
- 删除 Agent。
- 删除 Artifact。
- 可能的取消 Run。

### P6.4 键盘导航

必须支持：

- Tab 顺序合理。
- Enter/Space 激活按钮。
- Esc 关闭 Dialog/Drawer/Menu。
- Arrow keys 导航 Menu，可选。
- Composer IME。
- Search 快捷键。

### P6.5 Focus

- 所有交互控件有 `focus-visible`。
- Dialog 打开聚焦首个控件。
- Dialog 关闭还原焦点。
- 搜索跳转后聚焦目标消息或至少可感知高亮。

### P6.6 ARIA

补：

- Icon-only button `aria-label`。
- Loading `aria-live`。
- Error `role="alert"`。
- Dialog role/title/description。
- Tabs 使用 tablist/tab/tabpanel。
- Tree 使用 tree/treeitem，或至少语义 button list。

### P6.7 图片和预览

- 所有 `<img>` 有 alt。
- 装饰图使用空 alt。
- Artifact iframe 有 title。
- iframe sandbox 保持安全。

### P6.8 动效

动效应服务于状态：

- Drawer。
- Panel resize。
- Message streaming。
- Search highlight。
- Copy success。

遵守 `prefers-reduced-motion`。

### P6 验收标准

- Light/Dark 主界面无明显白块或不可读文字。
- 原生 confirm 全部替换。
- Icon button 有可访问名称。
- Tab、Dialog、Drawer 可键盘操作。
- ESLint accessibility 无 error。
- 200% 浏览器缩放仍能完成核心操作。

---

## P7 - 测试、性能和发布验收

### 目标

把关键 UI 工作流变成可回归行为，避免 Store 通过但界面操作失效。

### P7.1 Store 测试

补充 actions：

- Composer 分桶。
- Reply target。
- Pending attachments。
- Open file tabs。
- Close active tab。
- Conversation pin。
- Optimistic message。
- Plan review。

### P7.2 Reducer 测试

覆盖：

- Dispatch pending → approved → executing。
- Compaction job 状态。
- Pending approval 重放。
- Run failure 自动关闭 Tool 卡。
- Message event 幂等。
- Artifact update。

### P7.3 组件测试

优先：

1. `MessageInput`
2. `DispatchPlanEditor`
3. `PendingApprovalPanel`
4. `WorkspaceFileBrowser`
5. `ConversationTabBar`
6. `ArtifactPanel`
7. `CreateAgentDialog`
8. `Sidebar`

### P7.4 浏览器端工作流

使用 Playwright 或现有浏览器测试能力验证：

```text
创建会话
  -> 发送消息
  -> 收到流式回复
  -> 审核计划
  -> 批准写入
  -> 打开 Diff
  -> 打开 Artifact
  -> 部署
```

### P7.5 响应式截图

至少：

- 1440 × 900。
- 1280 × 800。
- 1024 × 768。
- 768 × 1024。
- 390 × 844。

检查：

- 重叠。
- 截断。
- 横向溢出。
- Drawer。
- Dialog。
- Composer。

### P7.6 性能

重点检查：

- Streaming 每个 token 是否导致整个页面重渲染。
- Message selector 是否保持稳定引用。
- 大会话 500 条消息滚动。
- Artifact 大文件。
- Search 结果。
- File tree 大目录。

可选优化：

- Message list virtualization。
- Tool result 延迟展开。
- Artifact lazy load。
- File content cache。

不要在没有测量前引入复杂 virtualization。

### P7.7 错误恢复

浏览器工作流覆盖：

- SSE 断线。
- API 500。
- 上传失败。
- Plan 审核冲突。
- Artifact 404。
- 文件读取 403/415。
- 部署失败。
- 压缩失败。

### P7.8 发布命令

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
```

此外进行浏览器 smoke test：

- 首页打开。
- 创建会话。
- 发送消息。
- 打开右栏。
- 打开 Settings。
- 搜索。

### P7 验收标准

- 核心组件有行为测试。
- 关键用户工作流有浏览器测试。
- 五个目标 viewport 无重叠。
- 500 条消息不会明显冻结。
- 四条质量命令和 diff-check 通过。

## 8. Store 目标结构

建议最终补充：

```typescript
interface AppState {
  composerDraftByConversation: Record<string, string>;
  mentionedAgentIdsByConversation: Record<string, string[]>;
  replyTargetByConversation: Record<string, string | null>;
  pendingAttachmentsByConversation: Record<string, PendingAttachmentDraft[]>;

  openFilesByConversation: Record<string, string[]>;
  activeTabByConversation: Record<string, string>;
  fileCacheByConversation: Record<string, Record<string, FileCacheEntry>>;

  mobileSidebarOpen: boolean;
  mobileWorkspaceOpen: boolean;

  operationErrors: Record<string, string>;
}
```

Actions：

```typescript
setComposerDraft(conversationId, draft)
setMentionedAgents(conversationId, ids)
setReplyTarget(conversationId, messageId)
addPendingAttachment(conversationId, attachment)
removePendingAttachment(conversationId, id)
clearComposerState(conversationId)

openFile(conversationId, path)
closeFile(conversationId, path)
openDiff(conversationId, pendingId)
setActiveTab(conversationId, tabId)

setMobileSidebarOpen(open)
setMobileWorkspaceOpen(open)
```

## 9. 推荐组件树

```text
AppShell
├── ResponsiveSidebar
│   ├── SidebarHeader
│   ├── SidebarNavigation
│   ├── ConversationList
│   │   └── ConversationItem
│   ├── ArtifactLibrary
│   ├── AgentsPanel
│   └── AnalyticsPanel
├── ChatWorkspace
│   ├── ChatHeader
│   │   ├── ConversationAgentStack
│   │   ├── ChatHeaderActions
│   │   └── ConnectionBadge
│   ├── ConversationTabBar
│   ├── ChatTab
│   │   ├── PinnedMessagesBar
│   │   ├── MessageList
│   │   │   └── MessageItem
│   │   │       ├── MessageActions
│   │   │       ├── QuotedMessage
│   │   │       ├── MessageParts
│   │   │       └── DispatchCard
│   │   ├── PendingDecisionStack
│   │   └── MessageComposer
│   │       ├── ReplyPreview
│   │       ├── PendingAttachmentList
│   │       ├── AgentMentionControl
│   │       ├── ApprovalModeControl
│   │       └── ComposerInput
│   ├── FileTab
│   └── PendingWriteDiffTab
└── ResponsiveWorkspacePanel
    ├── WorkspaceFileBrowser
    └── ArtifactPanel
```

## 10. 依赖关系

```text
P0 空操作与状态语义
  ├─> P1 Composer 与消息
  ├─> P2 计划审核
  └─> P3 文件工作台

P1 + P2 + P3
  └─> P5 响应式布局

P3
  └─> P4 Artifact/部署整合

P0-P5
  └─> P6 视觉与可访问性

P0-P6
  └─> P7 测试与发布
```

P4 的 Agent Builder 部分可以与 P2/P3 并行。

## 11. 推荐实施顺序

1. P0：消灭空按钮和错误会话 Pin。
2. P1：完成 Composer、附件、引用和消息 Pin。
3. P2：完成结构化计划审核。
4. P3：完成 File/Diff Tabs。
5. P4：完成 Artifact 部署和 Agent Builder 收口。
6. P5：做响应式布局。
7. P6：统一视觉、Dark Mode 和可访问性。
8. P7：补浏览器工作流测试和性能验收。

## 12. 推荐提交拆分

```text
fix(ui): wire chat header actions and remove dead controls
fix(domain): separate conversation pin from pinned messages

feat(composer): add conversation-scoped drafts mentions and attachments
feat(messages): add reply pin edit and optimistic send flows

feat(orchestrator-ui): add editable plan review card
feat(orchestrator-ui): show recovery and aggregate completion states

feat(workspace-ui): add conversation file tabs
feat(workspace-ui): add pending write diff tabs

fix(artifact-ui): use deterministic deployment API for candidates
feat(artifact-ui): complete version compare and error states
refactor(agent-builder): make DeepSeek-only support explicit

feat(responsive): add sidebar and workspace drawers
refactor(theme): align core components with semantic color tokens
feat(a11y): add keyboard focus and dialog semantics

test(ui): cover composer plan review workspace and artifact flows
test(e2e): add multi-agent collaboration browser workflow
```

## 13. 阶段性完成定义

### 达到 85%

- P0 完成。
- P1 Composer 核心闭环完成。
- Header 无空操作。
- 会话 Pin 语义正确。

### 达到 90%

- P2 结构化计划审核完成。
- P3 File/Diff Tabs 完成。
- Artifact 部署候选修复。

### 达到 95%

- P4 全部完成。
- P5 目标 viewport 可用。
- Dark Mode 主组件一致。

### 达到 100%

- P0-P7 全部完成。
- 键盘和基本可访问性通过。
- 浏览器端完整协作流程通过。
- 无空按钮、无假操作、无页面级溢出。
- TypeScript、Lint、测试、Build 和 diff-check 全部通过。

## 14. 最终验收清单

### Shell 与导航

- [ ] Sidebar 展开和折叠稳定。
- [ ] Sidebar Drawer 在窄屏可用。
- [ ] Header 所有按钮有行为。
- [ ] Artifact/Files active 状态正确。
- [ ] 右栏打开、关闭、切换和 resize 正常。

### Conversation

- [ ] 创建单聊和群聊。
- [ ] 添加/移除 Agent。
- [ ] 重命名、归档和删除。
- [ ] 会话置顶不污染消息 Pin。
- [ ] 会话搜索和排序正确。

### Composer

- [ ] Draft 按会话保存。
- [ ] @Agent 可选。
- [ ] 附件上传和发送。
- [ ] Auto/Review 可切换。
- [ ] Reply Preview。
- [ ] IME Enter 正确。
- [ ] 乐观消息和失败重试。

### Messages

- [ ] Text/Markdown。
- [ ] Thinking。
- [ ] Tool Use/Result。
- [ ] Artifact Ref。
- [ ] Deployment。
- [ ] Attachments。
- [ ] Pin/Unpin。
- [ ] Quote/Jump。
- [ ] Edit/Withdraw。
- [ ] Error/Aborted 状态。

### Orchestrator

- [ ] Pending Plan 可编辑。
- [ ] Agent assignment 可修改。
- [ ] Dependencies 可修改。
- [ ] Acceptance Criteria 可修改。
- [ ] Approve/Reject/Revise。
- [ ] 执行 task 状态。
- [ ] attempt 和错误。
- [ ] Recovery 区分。
- [ ] Aggregate 完成状态准确。

### Pending Decisions

- [ ] fs_write Diff。
- [ ] Bash command。
- [ ] ask_user。
- [ ] Dispatch Plan。
- [ ] Loading 和重复提交保护。
- [ ] SSE 后自动清理。

### Workspace

- [ ] 文件树。
- [ ] 文件中央 Tab。
- [ ] 多文件 Tabs。
- [ ] Diff Tab。
- [ ] Reload。
- [ ] Agent 修改提示。
- [ ] 大文件截断提示。
- [ ] 二进制错误提示。

### Artifact

- [ ] 文档预览/编辑。
- [ ] Web App 文件/预览。
- [ ] PPT Slide。
- [ ] 保存新版本。
- [ ] 版本历史。
- [ ] 版本比较。
- [ ] 正式部署 API。
- [ ] 打开/复制 URL。
- [ ] 下载。
- [ ] 404/失败/重试。

### Agent Builder

- [ ] 默认 Custom + DeepSeek。
- [ ] model 必填。
- [ ] key fallback 提示准确。
- [ ] Base URL 校验。
- [ ] Tool preset。
- [ ] 权限风险摘要。
- [ ] Quick draft 审核后保存。
- [ ] SDK Adapter 不误导用户。

### Search 与 Context

- [ ] 全局搜索。
- [ ] 过滤和分页。
- [ ] 跳转消息。
- [ ] 高亮自动清理。
- [ ] Context 预算分项。
- [ ] 压缩状态。
- [ ] 压缩错误和 retry。

### Responsive

- [ ] 1440px。
- [ ] 1280px。
- [ ] 1024px。
- [ ] 768px。
- [ ] 390px。
- [ ] 无页面级横向溢出。
- [ ] Drawer 和 Dialog 可关闭。

### Visual/A11y

- [ ] Light。
- [ ] Dark。
- [ ] focus-visible。
- [ ] Icon aria-label。
- [ ] Dialog semantics。
- [ ] Tabs semantics。
- [ ] Error aria-live。
- [ ] Image alt。
- [ ] Reduced motion。

### Quality

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `git diff --check`
- [ ] 浏览器工作流通过
- [ ] 目标 viewport 截图通过
