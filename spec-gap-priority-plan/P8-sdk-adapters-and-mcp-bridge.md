# P8 - ClaudeCode/Codex Adapter 与内部 MCP Bridge

## 对应 specs

- `specs/01-core-entities.md`
- `specs/05-adapter-interface.md`
- `specs/07-tools.md`
- `specs/10-agent-builder.md`
- `specs/11-platform.md`
- `specs/12-desktop-electron.md`

## 当前问题

Specs 里描述 ClaudeCodeAdapter 和 CodexAdapter 已实现，但当前代码事实是：

- `src/server/adapters/claude-code-adapter.ts` 不存在。
- `src/server/adapters/codex-adapter.ts` 不存在。
- registry 只有 mock/custom。
- package 里有相关 SDK 依赖，但没有实际 adapter 接线。
- 没有 AgentMeld 内部 MCP bridge 脚本。
- Agent Builder 允许选择 claude-code/codex，容易误导用户。

## 需要做的内容

1. ClaudeCodeAdapter。
   - 基于 `@anthropic-ai/claude-agent-sdk`。
   - query stream -> StreamEvent。
   - partial assistant text -> part.delta。
   - tool_use/tool_result -> tool.call/tool.result。
   - SDKResult usage -> run.usage。
   - 支持 abort。
   - 支持 session resume 或明确第一版不支持。

2. ClaudeCode canUseTool 桥。
   - 路径校验。
   - Bash 黑名单。
   - Bash critical approval。
   - Write/Edit review 模式桥到 PendingWrite。
   - Auto 模式允许。
   - run abort 清 pending。

3. CodexAdapter。
   - 基于 `@openai/codex-sdk`。
   - 使用隔离 `CODEX_HOME`。
   - Review 模式 read-only。
   - Auto 模式 workspace-write。
   - networkAccess disabled。
   - webSearch disabled。
   - 事件翻译到 StreamEvent。
   - usage 映射。

4. 内部 MCP bridge。
   - 暴露 `write_artifact/read_artifact/deploy_artifact/deploy_workspace/ask_user/report_task_result`。
   - 通过受保护内部 API 或 in-process 方式调用 toolRegistry。
   - 不暴露 bash/fs_write/fs_read 给 Codex bridge，避免绕过策略。

5. Registry 与 Agent Builder。
   - registry 注册 claude-code/codex。
   - Agent Builder 解除 disabled 状态。
   - SDK adapter 强制 `toolNames=[]`。
   - Base URL 协议校验：Codex 必须 Responses 兼容。

6. 测试。
   - Adapter 事件翻译单测。
   - abort 单测。
   - permission bridge 单测。
   - registry 单测。
   - 缺 CLI/缺 key 时错误消息可见。

## Spec 05 SDK Adapter 详细计划

### AdapterInput 前置要求

P8 开始前，P1 必须已完成：

- AdapterInput 有 `runId`。
- AdapterInput 有 `workspacePath`。
- AdapterInput 有 `systemPrompt`。
- AdapterInput 有 `apiKey`。
- AdapterInput 有 `parentRunId`。
- AdapterInput 可携带 attachments。
- AgentRunner 已能 resolve settings/env/per-agent key。

如果 P1 没完成，SDK adapter 会被迫直接查 DB 和拼上下文，后面会很难维护。

## A. ClaudeCodeAdapter 详细设计

### 新增文件

- `src/server/adapters/claude-code-adapter.ts`
- `src/server/adapters/claude-code-adapter.test.ts`
- `src/server/adapters/claude-permission-bridge.ts`
- `src/server/adapters/claude-permission-bridge.test.ts`
- `src/server/sdk-env.ts`

### 运行模型

ClaudeCodeAdapter 封装 `@anthropic-ai/claude-agent-sdk`。

职责：

- 启动 SDK query。
- 把 SDK stream 翻译成 StreamEvent。
- 接入 canUseTool 权限桥。
- 映射 usage。
- 支持 abort。
- 不直接写 DB，不直接发 SSE。

### Options 构造

需要明确：

- cwd = input.workspacePath。
- abortController 由外部 signal 桥接。
- model = agent.modelId 或默认。
- systemPrompt = Claude Code preset + input.systemPrompt append。
- permissionMode = default。
- tools = SDK preset。
- env 注入：
  - ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN。
  - ANTHROPIC_BASE_URL。
  - HOME fallback。

### 事件翻译

SDK message -> StreamEvent：

- partial assistant text -> `part.start(text)` + `part.delta(text.append)`。
- assistant text fallback -> 如果没有 partial，则整体 text part。
- tool_use -> `tool.call`。
- tool_result -> `tool.result`。
- result success -> usage + normal end。
- result error -> throw 或 yield error text，交 AgentRunner 结束 failed。

需要维护：

- SDK tool_use id -> AgentMeld callId map。
- 当前 partIndex。
- text part 是否已经 started。

### canUseTool 权限桥

路径工具：

- Read/Grep/Glob 可只检查 workspace containment。
- Write/Edit/NotebookEdit：
  - resolve path。
  - 读取 oldContent。
  - 计算 newContent。
  - conversation fsWriteApprovalMode=auto -> allow。
  - review -> register PendingWrite。
  - approve -> allow，SDK 自己写。
  - reject -> deny。

Bash：

- findBannedPattern 命中 -> deny。
- critical approval 命中 -> register PendingBash。
- approve -> allow。
- reject -> deny。

其它工具：

- MVP 默认 allow。
- WebFetch/WebSearch 是否允许要明确，建议默认 deny 或根据项目设置。

### PendingWrite skipWrite

Claude SDK 自己执行 Write/Edit，所以 PendingWrite approve 时不能由我们的 pending write API 再写一次文件。

需要扩展 PendingWrite：

```ts
skipWrite?: boolean
```

或单独在 permission bridge 中等待 approve/reject，不复用 fs_write 的“approve 后写盘”路径。

推荐拆开：

- AgentMeld `fs_write` pending：approve 后 API 写盘。
- Claude SDK Write/Edit pending：approve 后只唤醒 SDK，API 不写盘。

否则容易重复写或写入内容不一致。

### Session resume

第一版可以先不持久化 session，但要明确：

- 内存 map key = `${conversationId}:${agentId}`。
- withdraw/edit/compact/delete conversation 时清理 session。
- 如果 SDK 支持 previousSessionId，后续接入。

### ClaudeCodeAdapter 测试

可用 fake SDK stream 单测，不调用真实 Claude：

- partial text -> part delta。
- tool_use/result 配对。
- SDK error -> run failed visible message。
- abort signal -> iterator 停止。
- canUseTool Write review approve -> allow。
- canUseTool Write reject -> deny。
- canUseTool Bash banned -> deny。

## B. CodexAdapter 详细设计

### 新增文件

- `src/server/adapters/codex-adapter.ts`
- `src/server/adapters/codex-adapter.test.ts`
- `src/server/adapters/codex-runtime-config.ts`
- `scripts/agentmeld-codex-mcp.mjs`
- `scripts/agentmeld-codex-mcp.test.mjs` 或对应 node/vitest 测试

### 运行模型

CodexAdapter 使用 `@openai/codex-sdk`，不 spawn CLI。

关键原则：

- 使用 AgentMeld 管理的 `CODEX_HOME`。
- 不读取用户本机 `~/.codex`。
- network disabled。
- webSearch disabled。
- approvalPolicy never。
- Review 模式 read-only。
- Auto 模式 workspace-write。

### 配置

根据 conversation fsWriteApprovalMode：

- review -> sandboxMode read-only。
- auto -> sandboxMode workspace-write。

Base URL：

- agent.apiBaseUrl 可选。
- 必须是 Codex/Responses 兼容 endpoint。
- DeepSeek/OpenAI Chat Completions-only endpoint 应在运行前拒绝，并提示改用 custom adapter。

API key：

- agent.apiKey -> settings.openaiApiKey -> CODEX_API_KEY -> OPENAI_API_KEY。

### 事件翻译

Codex SDK event -> StreamEvent：

- agent_message -> text part。
- reasoning/todo_list -> thinking part。
- command_execution -> tool.call/tool.result。
- file_change -> tool.call/tool.result 或 structured code/file part，第一版建议 tool card。
- mcp_tool_call -> tool.call/tool.result。
- turn.completed.usage -> run.usage。
- write_artifact MCP result -> artifact.create。
- deploy MCP result -> deploy.status。

### Thread/session

需要支持：

- startThread。
- resumeThread(threadId)。
- map key = `${conversationId}:${agentId}`。
- delete/withdraw/edit/compact 时清理。

第一版可用内存 map，后续再持久化。

### AgentMeld MCP bridge

Codex adapter 需要内部 MCP bridge 暴露安全工具：

- `write_artifact`
- `read_artifact`
- `deploy_artifact`
- `deploy_workspace`
- `ask_user`
- `report_task_result`

不暴露：

- `bash`
- `fs_read`
- `fs_write`

原因：Codex runtime 自己已有文件/命令机制，直接暴露我们的 fs/bash 会形成双重权限模型，难以审批。

Bridge 通信方案：

1. stdio MCP server。
2. 启动时注入 internal base URL 和 internal token。
3. bridge 调内部 API 执行 allowlist tools。
4. tool result 返回给 Codex。

需要新增内部 API 或 in-process handler：

- 如果走 HTTP，必须有不可猜测 token。
- 如果 in-process，Electron/standalone 打包要保证脚本能加载。

### CodexAdapter 测试

用 fake SDK event stream：

- text event -> part delta。
- command event -> tool card。
- usage event -> run.usage。
- MCP write_artifact -> artifact.create。
- review 模式 config 是 read-only。
- auto 模式 config 是 workspace-write。
- DeepSeek baseUrl 被拒绝。
- abort 停止 run。

## C. Registry 与 UI 联动

Registry：

- `registry.ts` 注册 mock/custom/claude-code/codex。
- getAdapter 未找到时错误包含 adapterName。

Agent Builder：

- P8 完成后解除 claude-code/codex disabled。
- SDK adapter 下隐藏 provider/tool selection。
- Codex Base URL 字段提示 Responses 兼容。
- Claude Code 缺 CLI 时在运行时错误，不在创建时阻塞。

## D. 打包影响

如果 P9 Electron 未做，P8 仍可先在 Web dev 环境运行。

但需要提前注意：

- `next.config.ts` `serverExternalPackages`。
- SDK optional dependencies。
- Codex runtime binary 查找。
- MCP bridge script 需要被 standalone trace。

这些可先记录 TODO，到 P9 Electron 时处理。

## 验收标准

- 创建 claude-code agent 后能启动 run，缺 CLI 时显示清晰错误。
- Claude Code 写文件在 review 模式下进入 pending write。
- Codex agent 不读取用户本机 `~/.codex`。
- Codex review 模式不会自动写盘。
- SDK adapter 的 run.usage 能写入 DB。
- Agent Builder 中 SDK adapter 的工具选择被隐藏。

## 不在本优先级范围

- 不做外部 MCP server。
- 不做 Codex patch approval hook，除非 SDK 已支持。
- 不把 Claude Code CLI 打包进项目。
