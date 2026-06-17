# P6 - 前端 Store 与 UI 组件补全

## 目标

把前端从“能显示事件”提升到“能支撑真实多 Agent 工作流”。重点是 Store 一致性、pending 操作、dispatch 进度、artifact/deploy 面板和响应式布局。

## 当前基础

`src/stores/app-store.ts` 已能处理 run/message/tool/artifact/deploy/pending events。组件层已有 chat、sidebar、agent panel、artifact panel、pending approval panel、settings dialog 等。

## 参考图目标

`agent-conference-preview.png` 是 P6 的主要 UI 参考。P6 应把当前前端整理成三栏工作台：

```text
┌───────────────┬─────────────────────────────┬──────────────────────────────┐
│ Sidebar       │ Chat Workspace              │ Artifact Workspace           │
│ nav + convs   │ messages + composer         │ preview/edit/version/deploy  │
└───────────────┴─────────────────────────────┴──────────────────────────────┘
```

### 左侧 Sidebar

- 顶部品牌区：项目名、短说明、设置、主题切换、折叠按钮。
- 主导航：对话、产物库、Agents、分析。
- 新建对话按钮。
- 会话搜索输入框和筛选按钮。
- 会话列表 item：
  - 圆形 avatar 或缩写。
  - 会话标题单行截断。
  - 第二行展示“群聊/单聊 · N 位 Agent”。
  - 当前会话浅色高亮，左侧或背景有明确选中态。
- 底部用户/本地状态入口。

### 中间 Chat Workspace

- Header：
  - Agent avatar stack。
  - 会话标题和副标题。
  - 工具按钮组：布局/产物/文件/调度/添加 Agent。
  - token usage badge。
  - SSE 连接状态，例如“已连接”。
- 消息区：
  - user message 靠右，agent/system/orchestrator 靠左。
  - Agent 消息显示 avatar、名称、时间、token usage。
  - markdown、表格、代码、thinking、tool card、artifact/deploy part 都在消息内渲染。
  - Orchestrator thinking 使用虚线浅灰折叠块。
- Composer：
  - 输入框 placeholder 包含“输入消息，@ 指定 Agent，Enter 发送，Shift+Enter 换行”。
  - 附件按钮。
  - fs write approval 状态/安全图标。
  - 发送按钮使用蓝色主按钮。

### 右侧 Artifact Workspace

- 由 P5 负责细节，P6 负责布局联动。
- 右侧面板打开时中间聊天区不应被遮挡。
- 可关闭右侧面板，回到双栏/单栏模式。

## 参考文件

- `src/stores/app-store.ts`
- `src/components/app-shell.tsx`
- `src/components/chat-panel.tsx`
- `src/components/message-parts.tsx`
- `src/components/pending-approval-panel.tsx`
- `src/components/artifact-panel.tsx`
- `src/components/artifact-library.tsx`
- `src/components/agents-panel.tsx`
- `specs/09-frontend-architecture.md`
- `openspec/specs/frontend/spec.md`

## 具体任务

1. Store 初始化补全。
   - bootstrap 时同时拉取 pending write/bash/dispatch plan。
   - active conversation 切换时刷新 pending 状态。
   - SSE 重连后补偿缺失事件。
   - 对齐 Spec 09，逐步从嵌套数组过渡到 normalized entity maps + relation buckets。
   - reducer 对重复 `run.start` / `message.start` / pending events 保持幂等。
   - 保存 `activeArtifactId`、右侧面板打开状态、当前 sidebar tab、chat active tab。

2. Dispatch UI。
   - 展示 Orchestrator plan。
   - 展示 task 状态：pending/running/complete/failed/skipped。
   - 展示 child run、assigned agent、dependencies。
   - Plan review 状态下只读展示计划，显示 approve/reject 和“在输入框描述修改意见”的提示。
   - Execution 状态下展示 dispatch progress。
   - 调度卡片应嵌入消息流，不做阻塞全屏 modal。

3. Pending approval UI。
   - write：diff、路径、agent、run、approve/reject。
   - bash：命令、cwd、风险、approve/reject。
   - plan：read-only plan、approve/reject、composer revise。

4. Message parts 展示。
   - tool_use/tool_result 可折叠。
   - thinking 默认折叠。
   - deploy_status 可点击预览。
   - artifact_ref 与 artifact panel 联动。
   - `deploy_candidates` 以候选卡片展示。
   - 未配对 tool_result 时在 run failed/aborted 后补错误结果，避免工具卡永久 loading。
   - markdown 表格需要与参考图一样在气泡内可读，不撑破容器。
   - code inline 和 fenced code 都要有稳定样式，长行可滚动。

5. 移动与窄屏适配。
   - 左侧会话、主聊天、右侧 artifact panel 在小屏下切换为 tabs/drawers。
   - 输入框、pending panel 不遮挡消息流。
   - 小屏时右侧 Artifact 面板变成全屏 sheet 或 tab，不压缩 iframe 到不可用。

6. 文件与 diff tabs。
   - PendingWrite 可打开中间区 diff tab。
   - File tab 支持 workspace 文件查看/编辑。
   - Artifact preview 与 file explorer 右侧面板互斥。

7. 用户消息编辑/撤回。
   - 只允许最新 user message 编辑或撤回。
   - 撤回会 abort 相关 running run，并删除关联消息/产物/run。
   - 编辑 = 撤回后用新内容重发。

8. 全局搜索 UI。
   - `Cmd/Ctrl+K` 打开搜索弹窗。
   - 搜索结果可跳转会话并高亮消息。
   - 中文短词走 LIKE 兜底，长词/英文走 FTS5。

9. Sidebar 组件级计划。
   - `SidebarShell`：固定宽度、纵向布局、底部状态。
   - `PrimaryNav`：对话/产物库/Agents/分析。
   - `ConversationSearch`：搜索输入和筛选按钮。
   - `ConversationListItem`：avatar、标题、副标题、选中态。
   - `NewConversationButton`：创建入口。

10. Chat 组件级计划。
   - `ChatHeader`：会话标题、agent stack、usage、连接状态、操作按钮。
   - `MessageList`：滚动、自动贴底、历史查看不强拉底。
   - `MessageItem`：user/agent/system/orchestrator 布局差异。
   - `MessageMeta`：agent name、time、token usage。
   - `ComposerBar`：输入、附件、安全/审批、发送。
   - `AgentMentionMenu`：`@` 触发 agent 选择。

11. Layout 组件级计划。
   - `WorkspaceLayout`：三栏 resize/fixed layout。
   - `ResizableDivider` 可后续加，首版可以固定宽度。
   - `RightPanelHost`：artifact/file/deploy 面板互斥显示。
   - `MobilePanelTabs`：窄屏下 sidebar/chat/artifact 切换。

## 验收标准

- 一次 Orchestrator 运行可以在 UI 中完整追踪。
- 所有 pending 操作都有明确按钮和反馈。
- SSE 重连后不会丢失关键状态。
- Artifact/deploy 点击后能定位到对应 panel。
- 桌面和移动宽度下无明显重叠。
- 最新用户消息可撤回/编辑重发。
- 全局搜索可跨会话定位 text message。
- 三栏工作台整体结构与 `agent-conference-preview.png` 对齐。
- Header、Sidebar、Composer、MessageItem、Artifact panel 都有稳定尺寸，不因 streaming 或 hover 状态造成明显跳动。
