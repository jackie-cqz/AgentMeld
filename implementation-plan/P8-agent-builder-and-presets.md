# P8 - Agent Builder 与工具预设

## 目标

提供用户可理解、可编辑的 Agent 创建/编辑界面，让不同 adapter 的配置不会互相混淆。

## 参考文件

- `openspec/specs/agent-builder/spec.md`
- `specs/10-agent-builder.md`
- `openspec/changes/add-agent-create-wizard/*`
- `openspec/changes/add-openai-compatible-custom-provider/*`
- `skills/add-adapter.md`
- `skills/add-tool.md`

## 范围

需要实现：

- `src/server/agent-service.ts`
- `src/app/api/agents/route.ts`
- `src/app/api/agents/[id]/route.ts`
- `src/components/create-agent-dialog.tsx`
- `src/components/agent-list.tsx`
- tool preset helpers
- default custom harness prompt

## UI 组件级实现计划

### UI 参考图对齐

参考图：`agent-conference-preview.png`。

P8 在参考图中主要对应左侧 `Agents` 导航入口和会话 header 的“添加 Agent”图标位。虽然截图没有展开 Agent Builder，但它暗示了这些设计约束：

- `Agents` 是 sidebar 的一级导航，不应藏在设置里。
- 会话 header 需要有“添加/管理 Agent”快捷入口，方便群聊工作流中调整成员。
- Agent 列表视觉应与会话列表一致：圆形缩写头像、名称、角色/adapter 副标题、状态标签。
- 创建/编辑 Agent 使用 dialog 或 side panel，不跳离当前聊天工作台。
- Adapter/tool 配置是工作台设置的一部分，UI 密度要偏工具型，不做营销式大表单页面。

### 页面区域

P8 的 UI 入口主要在 sidebar 的 Agents tab，以及创建/编辑 Agent 的 dialog。目标是让用户不用理解底层 adapter 差异，也能正确配置 Agent。

```text
Sidebar
  AgentsTab
    AgentList
      AgentListItem
    CreateAgentButton
ChatPanel
  ConversationHeader
    ManageConversationAgentsButton

CreateAgentDialog
  AgentCreationModeStep
  AgentBasicFields
  AdapterFields
    CustomAdapterFields
    ClaudeCodeAdapterFields
    CodexAdapterFields
    MockAdapterFields
  ToolPresetSelector
  ToolChecklist
  SystemPromptEditor
  AgentReviewSummary
```

### `AgentsTab`

职责：

- 展示所有 agents。
- 区分 built-in/user-created/orchestrator。
- 提供创建入口。
- 作为 sidebar 一级 tab，与参考图中的 `Agents` 导航一致。

状态来源：

- `appStore.agents`

交互：

- 点击 agent 打开编辑 dialog。
- 创建按钮打开空白 create dialog。
- built-in agent 显示不可删除标识。

验收：

- Agent 列表能显示 adapter、model、工具数量。
- Orchestrator 有明确标签。
- 从 sidebar 切到 Agents tab 后不改变当前 active conversation。

### `AgentListItem`

展示字段：

| 字段 | 说明 |
|---|---|
| name | Agent 名称 |
| description | 简短描述 |
| adapterName | custom/claude-code/codex/mock |
| modelId | custom 必填，SDK 可选 |
| capabilities | 标签 |
| isBuiltin | 内置标识 |
| isOrchestrator | 编排器标识 |

视觉：

- 使用圆形缩写头像，与会话列表头像保持一致。
- adapter/model 放在副标题，避免主标题过载。
- built-in 和 orchestrator 使用小 badge。

交互：

- 点击编辑。
- user-created agent 可显示 delete action。
- built-in delete action 禁用。

### `CreateAgentDialog`

职责：

- 同一组件处理 create/edit。
- edit mode 跳过创建模式选择。
- 保存前做 adapter-specific validation。
- 作为工作台内 dialog 打开，不导航到新页面。

状态模型：

```ts
type AgentDialogMode = 'create' | 'edit'
type AgentCreateStep = 'mode_choice' | 'wizard' | 'details' | 'review'
```

MVP 可直接进入 `details`，但结构上保留 wizard step，便于接 `openspec/changes/add-agent-create-wizard`。

API：

- `POST /api/agents`
- `PATCH /api/agents/[id]`

验收：

- create 和 edit 共用校验规则。
- 保存成功后关闭并刷新 store。

### `ManageConversationAgentsButton`

职责：

- 位于 ConversationHeader 的 icon 工具组中。
- 打开一个轻量弹窗，用于查看当前会话成员，并跳转到 Agent Builder 或添加已有 Agent。

MVP 行为：

- 只展示当前 conversation 的 agents。
- 提供“打开 Agents 管理”按钮切换 sidebar 到 Agents tab。
- 添加/移除成员可延后到 conversation settings。

验收：

- 群聊 header 中可看到管理 Agent 的入口。
- 单聊也可查看当前 Agent 配置入口。

### `AgentBasicFields`

字段：

| 字段 | 控件 | 规则 |
|---|---|---|
| name | input | 必填 |
| description | textarea | 可选 |
| capabilities | tag input 或多选 | 可选 |
| isOrchestrator | checkbox | MVP 内置才开放，普通用户创建时默认 false |

验收：

- name 为空时禁止保存。

### `AdapterFields`

职责：

- 根据 `adapterName` 分发具体配置字段。

#### `CustomAdapterFields`

字段：

| 字段 | 控件 | 规则 |
|---|---|---|
| modelProvider | select | 默认 DeepSeek |
| modelId | input/select | 必填 |
| apiBaseUrl | input | openai-compatible 必填 |
| apiKey | password input | 可空，走 settings/env fallback |
| supportsVision | checkbox | 可选 |

提示文案：

- 显示 key fallback 顺序。
- openai-compatible 说明必须是 Chat Completions endpoint。

#### `ClaudeCodeAdapterFields`

字段：

| 字段 | 控件 | 规则 |
|---|---|---|
| modelId | input | 可选 |
| apiBaseUrl | input | 可选，Anthropic-compatible |
| apiKey | password input | 可空，可走 OAuth/环境 |

UI 行为：

- 隐藏 Agent-Conference tool checklist。
- 显示“使用 SDK 内置工具集”的说明。

#### `CodexAdapterFields`

字段：

| 字段 | 控件 | 规则 |
|---|---|---|
| modelId | input | 可选，默认 `gpt-5-codex` |
| apiBaseUrl | input | 可选，但必须 Responses-compatible |
| apiKey | password input | 可空，走 OpenAI/CODEX fallback |

校验：

- `api.deepseek.com` 这类 Chat Completions-only host 直接提示错误。
- 隐藏 provider 和 Agent-Conference tools。

#### `MockAdapterFields`

字段：

- 无 key。
- 无 provider。
- 可选择 mock scenario，MVP 可暂缓。

### `ToolPresetSelector`

职责：

- 给 Custom agent 快速设置工具组合。

Preset：

| Preset | UI 文案 | 工具 |
|---|---|---|
| all-purpose | 通用协作 | artifact + workspace + ask_user |
| local-code | 本地代码 | fs/deploy/bash/read_artifact |
| artifact | 产物创作 | write/read/deploy artifact |
| review | 审查 | fs_list/fs_read/read_artifact/report_task_result |

交互：

- 点击 preset 覆盖 tool checklist。
- 手动勾选后 preset 状态变为 custom。

### `ToolChecklist`

职责：

- 显示 `toolRegistry` 暴露的工具。
- 仅 Custom adapter 可编辑。

展示：

- tool name
- 简短 description
- 风险标签：filesystem、command、approval、artifact

验收：

- `ask_user` 默认选中。
- 切到 Codex/Claude 时保存结果 `toolNames=[]`。

### `SystemPromptEditor`

职责：

- 编辑 Agent system prompt。
- 创建 Custom agent 时预填默认 harness prompt。

交互：

- 支持重置默认 prompt。
- 显示字数/字符数。

验收：

- prompt 可保存。
- 重置不会立即保存，只有提交后生效。

## Adapter 表单规则

| Adapter | 表单行为 |
|---|---|
| `custom` | 需要 provider、model、tools，可配置 api key/base URL |
| `claude-code` | 隐藏 provider/tools，model 可选，SDK 工具集 |
| `codex` | 隐藏 provider/tools，base URL 必须 Responses-compatible |
| `mock` | 无 key，无 provider，开发用 |

## Tool Presets

| Preset | 默认工具 |
|---|---|
| all-purpose | artifact + file + bash + ask_user |
| local-code | `deploy_workspace`、`read_artifact`、`fs_read`、`fs_write`、`bash` |
| artifact | `read_artifact`、`write_artifact`、`deploy_artifact` |
| review | `fs_list`、`fs_read`、`read_artifact`、`report_task_result` |

## 任务拆分

1. 实现 agent CRUD。
2. 内置 Agent 可编辑但不可删除。
3. Create dialog 默认进入 Custom。
4. 填入默认 Custom harness prompt。
5. 实现 adapter 切换时字段显隐。
6. 实现工具 checklist 和 presets。
7. 实现 Codex base URL 基础校验。
8. 可选实现 conversational draft wizard。

## 验收标准

- 用户能创建 Custom agent。
- 清空 Custom model 会被拒绝。
- 切到 Codex 后保存的 `toolNames=[]`。
- 内置 Agent 删除按钮不可用。
- Tool preset 能正确覆盖勾选项。
- API 和 UI 校验一致。

## 风险

- Agent 配置一旦写错，运行时错误会很难理解；表单应提前给出 adapter-specific hint。
- 新增工具时必须同步 UI checklist。
