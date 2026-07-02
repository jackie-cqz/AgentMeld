# P5 - Agent Builder 与 Settings

## 对应 specs

- `specs/01-core-entities.md`
- `specs/05-adapter-interface.md`
- `specs/08-db-schema.md`
- `specs/09-frontend-architecture.md`
- `specs/10-agent-builder.md`

## 当前问题

当前已实现：

- `src/server/agent-service.ts`
- `src/app/api/agents/*`
- `src/components/create-agent-dialog.tsx`
- `src/server/settings-service.ts`
- `src/app/api/settings/route.ts`

缺口：

- `CreateAgentDialog` 没有挂到任何 UI。
- Sidebar 的 Agents tab 只是静态按钮。
- 没有 AgentLibrary、Agent detail、edit flow。
- Settings API 没有 SettingsDialog。
- specs 中工具列表包括 deploy/read_attachment/ask_user，但当前 Agent Builder 只基于当前已有工具。
- 自建 custom openai-compatible 的 apiKey/apiBaseUrl 必填约束不严格。
- 内置 agent 在 spec 中“不可删但可改”，当前代码对 builtin update 直接拒绝。
- Anthropic provider 在 UI 可选，但 CustomAdapter 不支持。
- ClaudeCode/Codex 选项在 UI 可选，但 adapter 未实现。

## 需要做的内容

1. Sidebar tab 机制。
   - conversations/artifacts/agents/analysis 至少前三个可切换。
   - Agents tab 渲染 AgentLibrary。

2. AgentLibrary。
   - 列出 builtin 和 custom agents。
   - 显示 adapter、provider/model、工具权限、supportsVision。
   - 创建、编辑、删除入口。
   - builtin 禁止删除。

3. Agent 创建/编辑。
   - 挂载 CreateAgentDialog。
   - 创建成功后 upsert store。
   - 支持编辑 custom agent。
   - builtin 允许编辑哪些字段需和 spec 对齐。
   - SDK adapter 未实现前，UI 应禁用或标记“规划中”。

4. Agent Builder 配置源。
   - 建议新增 `src/shared/agent-builder-config.ts`。
   - 定义 AVAILABLE_AGENT_TOOLS 和中文权限说明。
   - 工具预设与实际 registry 保持一致。
   - 未实现工具不出现在可选列表，或显示 disabled。

5. SettingsDialog。
   - Sidebar 增加设置按钮。
   - 支持 openai/deepseek/ark/anthropic key。
   - 支持 anthropic base url。
   - 支持 deployment publish settings。
   - GET mask key，PATCH 保存时允许替换/清空。
   - 前端不长期保存明文 key。

6. 配置校验。
   - custom + openai/deepseek/volcano-ark 要求 modelId。
   - custom + openai-compatible 要求 modelId、apiKey、apiBaseUrl。
   - anthropic provider 暂时禁用或提示运行时不支持。
   - claude-code/codex 暂时禁用，直到 P8 实现 adapter。

## Spec 09/10 前端组件补全详细计划

### Agent Library

建议新增：

- `src/components/agent-library.tsx`
- `src/components/agent-card.tsx`
- `src/components/agent-detail-panel.tsx`
- `src/components/create-agent-dialog.tsx` 继续复用并扩展
- `src/components/edit-agent-dialog.tsx`

AgentLibrary 视图结构：

```text
AgentsPanel
  Header: 新建 Agent / 搜索 / 过滤 adapter
  Builtin section
    AgentCard[]
  Custom section
    AgentCard[]
  AgentDetailPanel
```

AgentCard 展示：

- avatar/name。
- builtin/custom badge。
- adapterName。
- provider/model。
- tool count。
- supportsVision。
- isConductor。
- 最近更新时间。

AgentDetailPanel 展示：

- systemPrompt 预览。
- toolNames 中文权限说明。
- API key 来源提示：per-agent / global settings / env / missing。
- model/provider/baseUrl。
- capabilities。

### Create/Edit Agent Dialog

当前 `CreateAgentDialog` 需要增强为：

1. Adapter 选择：
   - custom：可用。
   - claude-code：P8 前 disabled，显示“SDK adapter 尚未接入”。
   - codex：P8 前 disabled，显示“SDK adapter 尚未接入”。

2. Provider 选择：
   - openai：可用。
   - deepseek：可用。
   - volcano-ark：可用。
   - openai-compatible：可用，但强制 apiKey/apiBaseUrl。
   - anthropic：P8/P后续前 disabled 或显示运行时暂不支持。

3. Tool 选择：
   - 不展示未实现工具，或 disabled 显示“待实现”。
   - 工具必须有中文 label、风险说明、原始 tool name。
   - `plan_tasks` 不允许普通自建 agent 选择。
   - `report_task_result` 只由 Conductor dispatch 自动注入，不在普通工具列表出现。

4. Presets：
   - `minimal`: `read_artifact`, `write_artifact`
   - `research`: `read_artifact`, `read_attachment`, `ask_user`
   - `artifact`: `read_artifact`, `write_artifact`, `deploy_artifact`
   - `local-code`: `fs_read`, `fs_write`, `bash`, `read_artifact`, `deploy_workspace`
   - 未实现工具对应 preset 应 disabled 或自动省略并提示。

5. Review page：
   - 展示 Agent 将获得哪些权限。
   - 高风险工具：`bash`, `fs_write`, external MCP 需要显眼提示。
   - 保存前做最终校验。

### Settings Dialog

建议新增：

- `src/components/settings-dialog.tsx`
- `src/components/settings-button.tsx`

布局：

```text
SettingsDialog
  LLM Keys
    OpenAI
    DeepSeek
    Volcano Ark
    Anthropic
    Anthropic Base URL
  Deployment
    Enable external static publish
    Publish directory
    Public base URL
  Companion
    mode: off/lan/tailnet
  Advanced
    data dir display
```

Key 输入规则：

- password input。
- `autocomplete="off"`。
- GET 返回 masked value。
- 如果用户不输入新值，PATCH 不覆盖旧值。
- 清空按钮单独设置 null。
- 保存成功后重新 GET，继续显示 masked。

### API 与 Store

当前 app-store 没有 agent create/update/delete action。需要补：

```ts
createAgent(payload): Promise<Agent>
updateAgent(id, patch): Promise<Agent>
deleteAgent(id): Promise<void>
loadSettings(): Promise<MaskedSettings>
updateSettings(patch): Promise<MaskedSettings>
```

或者使用组件内 fetch，但完成后必须同步 `state.agents`。

建议 store 事件/动作：

- `upsertAgent(agent)`
- `removeAgent(agentId)`
- `setActiveSidebarTab(tab)`
- `openSettings()`

### Builtin Agent 策略

Spec 01/10 写的是“内置不可删但可改”。当前代码拒绝 builtin update。

需要做一个产品决定：

方案 A：按 spec，允许 builtin 编辑部分字段。

- 可编辑：modelProvider/modelId/apiKey/apiBaseUrl/systemPrompt/toolNames/supportsVision。
- 不可编辑：id、isBuiltin、isConductor、adapterName 可视情况锁定。
- 删除禁止。

方案 B：保持当前代码，builtin 不可改不可删。

- 需要更新 specs，明确 builtin 锁定。

推荐方案 A，因为用户需要给 builtin Conductor 配 key/model。

### 测试清单

- 创建 custom openai agent 成功。
- 创建 openai-compatible 缺 baseUrl 失败。
- 创建 openai-compatible 缺 apiKey 失败。
- SDK adapter 在未实现时 UI disabled。
- builtin delete 返回 400。
- builtin update 如果采用方案 A，则允许修改 systemPrompt/model。
- Settings PATCH 保存 key 后 GET 返回 masked。
- 清空 key 后 resolveApiKey fallback 到 env。

## 验收标准

- 用户可从 UI 创建 custom Agent。
- 创建后的 Agent 可加入新会话并被 @。
- 用户可从 SettingsDialog 保存 OpenAI/DeepSeek/Ark key。
- 不配置 key 时 CustomAdapter 给出清晰错误。
- openai-compatible 缺 baseUrl 时无法保存或无法创建。
- builtin agent 不可删除，但可编辑策略与 spec 一致。
- 未实现的 adapter/provider 不会误导用户以为可用。

## 不在本优先级范围

- 不做自建 Conductor。
- 不实现 ClaudeCode/Codex adapter。
- 不做 MCP server 选择。
