# P6 - 前端架构补齐

## 对应 specs

- `specs/02-stream-events.md`
- `specs/03-message-parts.md`
- `specs/09-frontend-architecture.md`
- `specs/17-conductor-plan-review.md`

## 当前问题

当前 UI 是轻量三栏版本：

- Sidebar：对话列表、新建对话。
- ChatPanel：消息流、运行状态、输入框。
- ArtifactPanel：最新 artifact 预览。

Specs 中要求的 UI 完整度更高：

- normalized store：messages/artifacts maps + ids buckets。
- Sidebar 四 tab：对话、产物库、Agents、分析。
- PinnedMessagesBar。
- MessageItem pin/edit/withdraw/reply。
- PendingWritesPanel、PendingBashCommandsPanel。
- DispatchPlanCard。
- FileExplorerPanel、FileTab、diff tab。
- ArtifactPreviewPanel 可滑入/切换/版本。
- Global Search trigger。
- UsageBadge popover。
- SSE StrictMode 单连接 refCount。

## 需要做的内容

1. Store 结构升级。
   - 保留当前简单 store 也可，但要补 activeArtifactId、activeSidebarTab、pending by conversation。
   - 若重构到 normalized store，分阶段迁移，避免一次性大改。

2. Sidebar tabs。
   - Conversations tab：当前能力。
   - Artifacts tab：ArtifactLibrary。
   - Agents tab：AgentLibrary。
   - Analysis tab：先放 run/usage 占位或隐藏。

3. MessageItem 完整化。
   - text 用 markdown renderer，禁用不安全 HTML。
   - code block 支持复制和语言显示。
   - tool_use/tool_result 按 callId 合并成 ToolUsePart。
   - bash 工具展示命令和输出块。
   - artifact_ref 可点击。
   - deploy_status/deploy_candidates 完整按钮。
   - attachment chip。
   - message status error/aborted 样式。

4. 用户消息操作。
   - pin/unpin。
   - reply target。
   - 最新 user message withdraw。
   - 最新 user message edit and resend。
   - 对应 API 和 store 同步。

5. Pending panels。
   - PendingWritesPanel。
   - PendingBashCommandsPanel。
   - PendingQuestionCard。
   - DispatchPlanCard read-only review。

6. StreamProvider 加固。
   - 模块级 EventSource ref + refCount，适配 React StrictMode。
   - 处理 connected/heartbeat。
   - onerror 不要无限重置业务状态。

7. 文件视图。
   - FileExplorerPanel。
   - FileTab。
   - PendingWriteDiffTab。
   - 与 ArtifactPreviewPanel 互斥。

## Spec 09 Store 重构详细计划

### 当前 Store 问题

当前 store 使用：

- `agents: Record<string, Agent>`
- `conversations: Record<string, Conversation>`
- `messagesByConversation: Record<string, Message[]>`
- `runsByConversation: Record<string, AgentRun[]>`
- `artifactsByConversation: Record<string, Artifact[]>`

这个结构适合 MVP，但后续功能会吃力：

- artifact_ref 点击需要按 artifactId 快速定位。
- search 跳转需要 messageId -> conversationId。
- pending queues 需要按 conversation 分桶。
- edit/withdraw 需要批量删除 messages/artifacts/runs。
- artifact library 需要跨 conversation 列表。
- dispatch card 需要 parentRunId -> child runs。

### 目标 Store 结构

建议逐步迁移到 normalized store：

```ts
interface AppState {
  agents: Record<string, Agent>;
  conversations: Record<string, Conversation>;
  messages: Record<string, Message>;
  artifacts: Record<string, Artifact>;
  runs: Record<string, AgentRun>;

  conversationOrder: string[];
  messageIdsByConversation: Record<string, string[]>;
  artifactIdsByConversation: Record<string, string[]>;
  runIdsByConversation: Record<string, string[]>;
  childRunIdsByParentRun: Record<string, string[]>;

  pendingWritesByConversation: Record<string, PendingWrite[]>;
  pendingBashByConversation: Record<string, PendingBashCommand[]>;
  pendingQuestionsByConversation: Record<string, PendingQuestion[]>;
  pendingPlansByConversation: Record<string, PendingDispatchPlan[]>;

  activeSidebarTab: "conversations" | "artifacts" | "agents" | "analysis";
  activeConversationId: string | null;
  activeArtifactId: string | null;
  fileExplorerOpen: boolean;
  openTabsByConversation: Record<string, string[]>;
  activeTabByConversation: Record<string, string>;
  replyTargetByConversation: Record<string, string | null>;
  highlightedMessageId: string | null;

  connectionStatus: "connecting" | "open" | "closed" | "error";
  lastHeartbeatAt: number | null;
}
```

### 迁移策略

不要一次性重写全部 UI。建议四步：

1. 增加 normalized maps，同时保留旧 buckets。
2. Bootstrap 时同时填充两套结构。
3. 新组件优先读 normalized selectors。
4. 旧组件逐步迁移后删除旧 buckets。

### Selectors

建议实现纯 selector/helper：

```ts
selectActiveConversation(state)
selectConversationMessages(state, conversationId)
selectConversationRuns(state, conversationId)
selectConversationArtifacts(state, conversationId)
selectActiveArtifact(state)
selectTopLevelRunningRuns(state, conversationId)
selectPendingApprovals(state, conversationId)
selectDispatchForRun(state, runId)
```

React 中用 shallow selector，避免每个 SSE delta 引起整个页面重渲染。

### applyEvent reducer 加固

必须补齐或修正：

- `message.start` idempotent。
- `part.start` 按 partIndex 设置，不 push。
- `part.delta` 只追加 text/code/thinking。
- `tool.call` 按 callId 幂等。
- `tool.result` 如果已有同 callId，应更新而不是重复 push。
- `artifact.create` 写 artifacts map 和 artifactIdsByConversation。
- `dispatch.plan.pending` 写 pendingPlansByConversation。
- `dispatch.plan` 创建 dispatch execution state。
- `dispatch.start` 更新 task running 和 childRunIds。
- `dispatch.end` 更新 task final status。
- `run.end` 时为未配对 tool_use 补本地 error tool_result，防止卡住。
- `message.removed` 批量删除 messages/artifacts/runs。

### Bootstrap payload

当前 `getBootstrapPayload()` 返回按 conversation 分组的数据。可以兼容：

- 前端 bootstrap 转 normalized。
- 或后端新增 normalized payload。

推荐先前端转换，减少 API 变更。

### 性能原则

- 流式 part.delta 只更新目标 message。
- MessageBubble 组件接收 messageId，自行 selector 取 message。
- ArtifactPanel 接收 artifactId。
- ChatPanel 不直接订阅整个 messagesByConversation 大数组。
- 对高频 delta，滚动操作需要节流或只在用户贴近底部时自动跟随。

## Spec 09 前端组件补全详细计划

### 组件树目标

```text
AppShell
  StreamProvider
  Sidebar
    ConversationLibrary
    ArtifactLibrary
    AgentLibrary
    AnalysisPanel
    SettingsButton
  ChatPanel
    ChatHeader
    ConversationTabs
    PinnedMessagesBar
    MessageList
      MessageItem
        MessageHeader
        MessageActions
        PartList
          MarkdownPart
          CodePart
          ThinkingPart
          ToolUsePart
          ArtifactRefPart
          DeployStatusPart
          DeployCandidatesPart
          AttachmentChip
        DispatchPlanCard
    PendingApprovalsPanel
    MessageInput
  RightPanel
    ArtifactPreviewPanel
    FileExplorerPanel
```

### MessageInput

需要补：

- @ mention popup，而不是只显示全部按钮。
- pending plan 时 composer 可切换为 revise feedback。
- attachment picker。
- reply target preview。
- Auto/Review conversation setting toggle。
- slash command 检测：`/deploy`, `/compact`。
- Enter/Shift+Enter 行为保持。

### MessageItem

需要补：

- pin/unpin 按钮。
- reply 按钮。
- 最新 user message edit。
- 最新 user message withdraw。
- aborted/error 样式。
- streaming spinner。
- agent popover。

### ToolUsePart

当前 tool_use/tool_result 分开显示或 fallback JSON。目标：

- 按 callId 合并。
- 展示 tool name、状态、耗时。
- 参数折叠。
- 结果折叠。
- bash 命令特殊样式。
- bash 输出特殊样式，支持复制。
- error result 红色状态。

### ArtifactRefPart

目标：

- 根据 artifactId 从 store 查 artifact。
- 缺失时 lazy fetch。
- 404 显示墓碑。
- 点击 `openArtifactPreview(id)`。
- 展示 title、type、version。

### DispatchPlanCard

P3 的 UI 部分：

- pending review 状态。
- approve/reject。
- task 列表。
- inputs/expectedOutputs/acceptance count。
- execution progress 状态。
- child run links。
- failed/skipped reason。

### PendingApprovalsPanel

整合：

- PendingWriteCard。
- PendingBashCommandCard。
- PendingQuestionCard。
- PendingDispatchPlanCard 或入口。

位置：

- MessageInput 上方。
- 不遮挡输入框。
- 多个 pending 可折叠。

### ArtifactPreviewPanel

目标：

- activeArtifactId。
- artifact list/dropdown。
- preview/source/edit/version tabs。
- web_app iframe。
- document markdown。
- image。
- ppt。
- code_file。
- diff legacy。
- version history。
- delete/rename。

### FileExplorerPanel

目标：

- 浏览 workspace 文件。
- 打开文件到 tabs。
- 只读/编辑模式。
- 保存用户手动编辑不走 Agent fs_write 审批。
- 与 ArtifactPreviewPanel 互斥。

### API 缺口

为支持前端组件，需要后端补：

- pin/unpin conversation messages。
- withdraw/edit latest user message。
- attachment upload/list/read。
- workspace file list/read/write。
- artifact versions。
- pending GET endpoints。
- deploy command。

### 测试清单

- Store reducer event replay 幂等。
- part.delta 高频更新只影响目标 message。
- artifact_ref 点击打开右侧 panel。
- pending write approve 后 UI 清理。
- run.end failed 补齐未完成 tool_result。
- Sidebar tabs 切换保持 active conversation。
- Message edit/withdraw 后删除关联 agent outputs。
- StrictMode 下只有一个 SSE connection。

## 验收标准

- Sidebar tabs 可切换，且不丢失当前会话状态。
- artifact_ref 点击打开右侧对应 artifact。
- pending write/bash/plan 都能从 UI 处理。
- tool card 不再显示裸 JSON 为主。
- 失败 run 的未配对 tool_use 不会永久显示“调用中”。
- 撤回/编辑最后一条 user message 后，相关 agent output 和 artifacts 被清理。
- StrictMode dev 下不会创建重复 SSE 连接。

## 不在本优先级范围

- 不做移动端 UI。
- 不做复杂设计系统重构。
- 不做拖拽 DAG 编辑。
