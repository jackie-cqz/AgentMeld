# P9 - Optional Adapters 与 MCP 扩展位

## 目标

在拿不到 Claude/Codex SDK 的情况下，保留清晰的扩展位，但不要让它们影响 DeepSeek 主线稳定性。

## 当前状态

`ClaudeCodeAdapter` 和 `CodexAdapter` 文件存在，但仍是 stub。`mcp-bridge.ts` 存在，后续可作为外部工具桥接基础。

## 参考文件

- `src/server/adapters/claude-code-adapter.ts`
- `src/server/adapters/codex-adapter.ts`
- `src/server/adapters/mcp-bridge.ts`
- `src/server/adapters/registry.ts`
- `specs/05-adapter-interface.md`
- `specs/15-external-mcp.md`
- `openspec/specs/adapters/spec.md`

## 具体任务

1. 将 Claude/Codex 标记为 optional。
   - UI 中显示“暂未启用”。
   - Agent Builder 默认不推荐选择。
   - 文档中说明当前主线是 DeepSeek Custom Agent。

2. Adapter contract 保持稳定。
   - 即使 SDK 不接，也不要频繁改 `AgentPlatformAdapter` 接口。
   - 新 adapter 必须输出统一 `StreamEvent`。

3. Stub 行为优化。
   - 当前 stub 会输出提示文本。
   - 可以增加更明确的配置建议：使用 Custom + DeepSeek。
   - 不要让 stub run 被误判为真实任务完成。

4. MCP bridge 延后。
   - 先不做外部 MCP 市场。
   - 后续只接入“本地可信 MCP server”。
   - MCP 工具也必须走同一套审批与 workspace 安全规则。

5. External MCP 数据模型预留。
   - 后续新增 `mcp_servers` 表：name、transport、command/args/env、url/headers、trust、enabled。
   - `agents` 增加 `mcpServerIds`，由用户按 agent opt-in。
   - UI 中必须清楚展示外部 MCP 运行在沙箱保证之外。

6. DeepSeek Custom MCP 路线。
   - 因当前不依赖 Claude/Codex SDK，若要让 DeepSeek agent 使用外部 MCP，需要单独实现 MCP client。
   - MCP tools 转成 OpenAI function calling tool，命名为 `mcp__server__tool`。
   - MCP 调用结果仍通过 `tool.call` / `tool.result` 展示。
   - 首版建议只做可信 stdio，本地用户手动登记。

7. MCP 安全审批。
   - 默认 trust=`ask`。
   - per-tool-per-conversation 首次调用审批。
   - run abort 时关闭 MCP 连接并杀 stdio 子进程树。
   - 连接失败不应拖垮整个 run，只让该 server 工具不可用。

## 验收标准

- 用户不会误以为 Claude/Codex 已经真实可用。
- DeepSeek 主线不依赖 optional adapters。
- 未来接 SDK 时不需要重写 AgentRunner。
- MCP 扩展保持为低风险预留能力。
- 外部 MCP 的数据模型、命名、信任模型在文档中有明确路线。
