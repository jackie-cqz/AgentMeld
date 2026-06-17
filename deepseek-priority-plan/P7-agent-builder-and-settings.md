# P7 - Agent Builder 与 DeepSeek 设置体验

## 目标

让用户可以不改代码创建 DeepSeek Custom Agent、配置模型、选择工具、设置角色，并清楚知道 Claude/Codex 当前不可用。

## 参考图关联

`agent-conference-preview.png` 左侧主导航中有 `Agents` 和顶部设置入口。P7 负责这些配置型 UI：

- Sidebar 中的 Agents tab。
- 顶部或左上设置按钮。
- Agent 创建/编辑对话框。
- DeepSeek API Key 设置。
- Adapter 可用性提示。

## 参考文件

- `src/components/create-agent-dialog.tsx`
- `src/components/settings-dialog.tsx`
- `src/server/agent-service.ts`
- `src/db/builtin-agents.ts`
- `src/shared/model-registry.ts`
- `src/shared/agent-constants.ts`
- `specs/10-agent-builder.md`
- `openspec/specs/agent-builder/spec.md`
- `openspec/changes/add-agent-create-wizard/`

## 具体任务

1. DeepSeek preset。
   - Provider: DeepSeek。
   - Adapter: custom。
   - Model: `deepseek-chat`。
   - Base URL 默认填充。
   - API Key 从全局 settings 读取。
   - `supportsVision` 根据所选模型能力给出默认值。

2. Agent 创建向导。
   - 基本信息：name、description、capabilities。
   - 模型配置：provider/model/baseUrl。
   - 工具选择：按用途分组。
   - 系统提示词：提供模板。
   - 支持“对话创建”草稿：用户描述想要的 agent，服务端生成 draft，用户 review 后保存。
   - 在 Agents tab 中以列表/卡片展示 agent：avatar、name、description、capabilities、adapter、model。

3. Adapter 可用性提示。
   - Custom: 可用。
   - Claude Code: SDK 未接入，暂不可用。
   - Codex: SDK 未接入，暂不可用。
   - 不允许用户误选不可用 adapter 后以为可以运行。
   - Anthropic provider 若 Custom adapter 尚未支持，也要警告或隐藏。

4. 设置页体验。
   - DeepSeek API Key 输入、保存、清除。
   - 可选增加“测试连接”按钮。
   - 错误提示不要泄露 key。
   - 设置入口放在 Sidebar 顶部，与参考图的齿轮按钮一致。
   - 连接状态可以显示在 ChatHeader，不塞进设置对话框常驻区域。

5. 内置 Agent 调整。
   - 默认 Orchestrator 使用 custom + DeepSeek。
   - 默认 worker agents 使用 custom 或 mock，依据是否配置 key。

6. 工具预设。
   - 全栈通用。
   - 本地代码。
   - 产物交付。
   - 审查验证。
   - 新增工具时同时更新 `AVAILABLE_AGENT_TOOLS` 和工具文案。

7. 内置与自建约束。
   - 内置 agent 可编辑但不可删除。
   - 自建 agent 默认不可成为 Orchestrator。
   - 后续支持自建 Orchestrator 时，需要强制装备 `plan_tasks` 并校验群聊最多一个 Orchestrator。

## 验收标准

- 用户只配置 DeepSeek API Key 就能创建并运行 Custom Agent。
- 不可用 adapter 在 UI 中有明确标记。
- Agent 工具选择不会保存未知工具名。
- 设置页保存后无需重启即可用于新 run。
- 对话创建草稿不会直接落库，必须经过用户 review。
- Agents tab 与设置入口能从参考图左侧导航自然进入。
