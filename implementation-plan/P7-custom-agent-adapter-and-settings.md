# P7 - Custom Agent Adapter 与 Settings

## 目标

让用户可以配置 OpenAI Chat Completions-compatible provider，并通过 CustomAgentAdapter 调用真实模型和 Agent-Conference-managed tools。

## 参考文件

- `openspec/specs/adapters/spec.md`
- `openspec/specs/persistence/spec.md`
- `openspec/specs/conversation-context/spec.md`
- `specs/05-adapter-interface.md`
- `specs/08-db-schema.md`
- `specs/13-conversation-context.md`
- `openspec/changes/add-openai-compatible-custom-provider/*`
- `AGENT_BACKEND.md` 第 3、13、14 章

## 范围

需要实现：

- `src/server/adapters/custom-agent-adapter.ts`
- `src/server/settings-service.ts`
- `src/app/api/settings/route.ts`
- provider/model registry
- API key resolution helper
- Custom adapter tool loop

## Key 解析优先级

参考 `specs/05-adapter-interface.md` 与 `specs/08-db-schema.md`：

1. `agents.api_key`
2. `app_settings.<provider>_api_key`
3. `process.env.<PROVIDER>_API_KEY`
4. SDK/provider 自身 fallback，仅在文档允许时使用

## Provider 范围

MVP 支持：

- OpenAI
- DeepSeek
- Volcano Ark
- OpenAI-compatible custom base URL

Anthropic 可保留配置字段，但 Custom adapter 的 Anthropic 路径可暂缓；Claude Code 走独立 SDK adapter。

## 任务拆分

1. 实现 settings get/patch API。
2. 实现 key normalize：空字符串存 null。
3. 实现 Custom adapter client 构建。
4. 实现 Chat Completions streaming。
5. 解析 text delta、reasoning delta、tool call delta。
6. 实现最多 8 轮 tool loop。
7. 工具结果回灌给模型。
8. 汇总 token usage。
9. 处理 provider error，生成可见错误消息。

## 验收标准

- 用户能保存 OpenAI/DeepSeek key。
- Custom agent 无 key 时不影响应用启动。
- 有效 key 能流式回复。
- DeepSeek reasoning 映射为 `thinking` part。
- 模型调用工具后能继续下一轮回复。
- AbortSignal 能中止网络请求。

## 风险

- 不同 provider 的 streaming tool call delta 细节不同，必须保持解析器可测试。
- OpenAI-compatible base URL 是 Chat Completions 协议，不要和 Codex/Responses base URL 混用。
