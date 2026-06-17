# P0 - DeepSeek 主线运行基线

## 目标

把 DeepSeek / OpenAI-compatible Custom Agent 确认为项目的默认主路径，并保证从 Agent 配置、API Key、消息发送、流式输出、工具调用到错误提示都有稳定闭环。

## 为什么是 P0

当前拿不到 Claude/Codex SDK，因此项目能不能继续推进取决于 `custom` adapter 是否足够稳定。DeepSeek 主线稳定后，后续 Orchestrator、工具、上下文、前端都可以围绕同一条运行链路迭代。

## 参考文件

- `src/server/adapters/custom-agent-adapter.ts`
- `src/server/agent-runner.ts`
- `src/server/settings-service.ts`
- `src/shared/model-registry.ts`
- `src/components/settings-dialog.tsx`
- `src/components/create-agent-dialog.tsx`
- `specs/05-adapter-interface.md`
- `openspec/changes/add-openai-compatible-custom-provider/`

## 具体任务

0. 建立规格一致性基线。
   - 对照 `specs/01-core-entities.md` 检查 `Agent`、`Conversation`、`Message`、`Artifact`、`Workspace`、`Attachment`、`AgentRun` 的字段与约束。
   - 对照 `specs/08-db-schema.md` 检查 DB schema 是否包含 `parent_run_id`、`usage`、`conversation_context_summaries`、`attachments`、`app_settings` 的 DeepSeek/API key/deployment 字段。
   - 对照 `specs/02-stream-events.md` 检查 `StreamEvent` 联合类型是否包含 run/message/part/tool/artifact/deploy/dispatch/pending/usage/heartbeat。
   - 保证 ID 前缀与 `src/shared/ids.ts` 一致，错误消息后续应使用 `msg_err_` 语义。

1. 确认 DeepSeek 默认 provider 配置。
   - 默认 base URL 使用 `https://api.deepseek.com/v1`。
   - 默认模型可使用 `deepseek-chat`。
   - 设置页明确 DeepSeek API Key 的用途。

2. 强化 `CustomAgentAdapter` 错误提示。
   - API Key 缺失时提示用户去 Settings 配置。
   - HTTP 401/403/429/5xx 给出不同错误文案。
   - JSON/tool call 解析失败时不能中断整轮运行。

3. 明确 Custom Agent 支持的工具协议。
   - 工具 schema 从 `toolRegistry` 统一导出。
   - 工具执行结果统一序列化，避免过长输出污染上下文。
   - 工具调用失败必须以 `tool.result` 返回给模型。

4. 建立 DeepSeek smoke test。
   - 无 API Key 场景测试。
   - mock OpenAI-compatible response 场景测试。
   - tool call roundtrip 场景测试。

5. 补齐 DeepSeek 特有协议。
   - `reasoning_content` 应作为 `thinking` part 流式展示。
   - 如果 DeepSeek 要求下一轮带回 reasoning content，需要在 Custom adapter 的 within-run messages 中保留对应字段。
   - usage 映射 DeepSeek cache hit 到统一 `RunUsage` 字段。

6. 明确附件/视觉输入边界。
   - `supportsVision=true` 且模型支持图片时，图片附件走 OpenAI-compatible image_url block。
   - 普通文件附件不自动塞入 prompt，只保留 metadata，由 agent 调 `read_attachment`。

## 验收标准

- 使用 DeepSeek API Key 创建 Custom Agent 后，可以完成一轮普通对话。
- 工具型 Agent 可以调用至少一个只读工具和一个审批型工具。
- API Key 缺失、模型错误、网络错误都有可读 UI 反馈。
- 核心实体、DB schema、StreamEvent 类型与 `specs/01`、`specs/02`、`specs/08` 没有明显漂移。
- `pnpm typecheck`、`pnpm test`、`pnpm build` 通过。
