# Spec 15 — 外部 MCP 工具接入（设计提案）

> 让**任意 adapter** 的 Agent 接入「用户配置的外部 MCP server」,把工具扩展统一到 MCP 协议上,而不必为每个能力手写内置工具。
>
> **状态:设计提案,未实现。** 本 spec 用于先对齐方案(CLAUDE.md §6.1),确认后再分期落地。涉及安全约束(§5)与跨层接口,**实现前需讨论**。

源文件(待建):`src/server/mcp/**`(client + registry) · 改动 `src/server/adapters/**`

---

## 1. 现状与动机

| Adapter | 工具机制 | 是不是 MCP client | 能接外部 MCP 吗 |
|---|---|---|---|
| `custom` | OpenAI function-calling + 内部 `toolRegistry` | ❌ 无 MCP | ❌ |
| `claude-code` | SDK 预置工具 + 进程内 `createSdkMcpServer`(只挂 `agentmeld`) | ✅(SDK 自带) | ❌(没接线) |
| `codex` | Codex 内置 + 外部 stdio MCP(只挂 `agentmeld`) | ✅(SDK 自带) | ❌(没接线) |

**问题**:三者目前都**只挂了内部 `agentmeld` 一个 MCP server**,没有「让用户接第三方 MCP server(filesystem / github / postgres / 自建…)」的路径;`custom` 连 MCP client 底子都没有。

**动机**:① 接入 MCP 生态 → 工具扩展不再靠手写;② 统一三个 adapter 的扩展入口;③ 复用现有 `tool.call`/`tool.result` 事件,不破坏契约。

---

## 2. 目标 / 非目标

**目标**
- 用户可在「设置」里登记外部 MCP server(stdio / SSE),并在 Agent 上勾选启用(像勾 `toolNames`)。
- **三个 adapter 统一支持**:claude-code / codex 主要是「接线」(SDK 本就是 MCP client),custom 需新建一个 MCP 客户端层。
- MCP 工具调用复用现有 StreamEvent,无新事件类型。
- 有明确的**信任/沙箱**模型(外部 MCP 会绕过现有沙箱,见 §6)。

**非目标(首版)**
- 不替换内置工具(`agentmeld` server 仍是内部桥接,见 spec 05/07)。
- 不做 MCP server 的**发布/托管**(AgentMeld 仍只作为 MCP client)。
- 首版不做 OAuth-flow 鉴权的远程 MCP(只支持 stdio 命令 + 带静态 header 的 SSE)。

---

## 3. 数据模型(推荐方案)

镜像「工具」的模型:**全局定义 server,Agent 按需 opt-in**。

**新表 `mcp_servers`**(详见 spec 08 待补):

```
id            text PK       // mcp_xxx
name          text unique   // 命名空间用,见 §5;仅 [a-z0-9_]
transport     'stdio' | 'sse'
command       text?         // stdio: 可执行(经平台白名单/校验)
args          json string[] // stdio
env           json record?  // stdio: 附加环境变量(白名单,见 §6)
url           text?         // sse: 端点
headers       json record?  // sse: 静态请求头(放 API key 等)
trust         'always' | 'ask'   // 默认 'ask',见 §6
enabled       boolean       // 全局开关
createdAt     integer
```

**`agents` 增列**:`mcpServerIds: json string[]`(默认 `[]`)——该 Agent 启用哪些 server,语义同 `toolNames`。

> **已定**:全局 `mcp_servers` 表 + per-agent `mcpServerIds` 引用(define-once-reuse、密钥集中管理、与 `toolNames` 模型一致)。不用 per-agent 内联(会重复配置 + 密钥分散)。

---

## 4. 各 Adapter 的接入方式

```
                       启用的 mcp_servers(按 agent.mcpServerIds 解析)
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
  claude-code:接线              codex:接线                custom:造客户端
  query() 的 mcpServers        config.mcp_servers          新建 MCP client 层
  里追加这些 server            里追加这些 server           (见下)
  (SDK 自管连接+工具暴露)      (Codex 自管)               
```

- **claude-code**:把启用的 server 转成 SDK 的 `mcpServers` 配置项,与现有 `agentmeld`(进程内)并列传入 `query()`。stdio server 由 SDK 自管子进程。**主要是格式转换 + 接线**。
- **codex**:把启用的 server 加进 `config.mcp_servers`(与现有 `agentmeld` 并列)。Codex runtime 自管。**接线**。
- **custom**:**新建 MCP 客户端层**(`@modelcontextprotocol/sdk` 已是依赖):
  1. run 开始:对每个启用的 server 建 `Client` + transport(`StdioClientTransport` / `SSEClientTransport`)并 `connect`。
  2. `listTools()` → 转成 OpenAI function-calling tool(名字加命名空间前缀,见 §5),**合并进**现有 `apiTools`。
  3. tool loop 里:工具名命中 `mcp__` 前缀 → 路由到对应 `client.callTool(...)`;否则走 `toolRegistry.execute`(现状不变)。
  4. run 结束 / abort:`close()` 所有 client,stdio 杀进程树(复用 `killProcessTree`,spec 11)。

---

## 5. 工具命名与事件(契约影响:最小)

- **命名空间**:外部 MCP 工具统一命名 `mcp__<serverName>__<toolName>`(对齐 claude-code/codex SDK 既有约定,如 `mcp__agentMeld__write_artifact`),避免与内置工具冲突。
- **事件**:MCP 工具调用复用现有 `tool.call` / `tool.result`(`specs/02`),`toolName` 用命名空间名。**不新增 StreamEvent,不破坏前端 reducer**。
- **artifact**:外部 MCP 工具一般不产 AgentMeld 产物;不触发 `artifact.create`(除非它显式返回 `artifactId` 并被约定识别——首版不做)。

---

## 6. 安全 / 信任模型（重点,§5 张力点）

外部 MCP server **运行任意代码(stdio)或访问外部网络(sse)**,**绕过 AgentMeld 的 workspace 沙箱 + Bash 黑名单**。这是本特性最大的安全口子,必须显式设计:

1. **显式 opt-in 两道**:server 由用户**手动登记**;Agent 由用户**手动勾选**。默认不启用任何外部 MCP。
2. **trust 级别**:
   - `always`:直接放行(用户明确信任的 server)。
   - `ask`(默认):MCP 工具调用走**审批门**(复用 `fs_write` 的 `pending` 机制,spec 07 / `pending-writes`)。**粒度 = per-tool-per-conversation**:某 `mcp__server__tool` 在一次会话内**首次**调用时弹审批,批准后该会话内该工具免再问;拒绝则该次调用返回 `isError`。(每次都问太吵;整个 server 一次批又太粗——同一 server 可能既有安全的读、又有危险的写。)
3. **stdio 收敛**:子进程 `cwd` 尽量限定到 workspace 的 effective cwd;`env` 走白名单(复用 `buildChildProcessEnv`);可执行命令做基本校验(不在本 spec 的 Bash 黑名单内,但应有独立的「危险命令」提示)。
4. **失败隔离**:某 server 连接/调用失败 → 该 server 工具标记不可用 + 警告,**不崩整个 run**。
5. **中止**:`AbortSignal` 触发时关闭所有 MCP 连接、杀 stdio 进程树。
6. **明确告知**:文档与 UI 必须写明「**外部 MCP 不在 AgentMeld 的沙箱保证范围内**」,这是用户授予的信任。

> 注:claude-code/codex 把沙箱委托给各自 SDK(canUseTool / Codex sandbox);custom 的 MCP 工具**不经我们的沙箱**——这是 custom 接 MCP 的固有代价,§6.2/§6.3 的审批门是主要缓解。

---

## 7. 生命周期 / 并发

- **custom**:首版 **per-run 连接 + 结束 teardown**(干净、无跨 run 状态,符合 adapter「不持久状态」原则);连接池化(per-conversation)作为 P2 优化。
- **claude-code / codex**:连接由 SDK 自管(随 query / thread)。
- stdio server 是子进程 → 必须保证 run 结束/中止时清理(否则泄漏进程),复用 spec 11 的子进程清理。

---

## 8. 配置 UI(出口,细节另议)

- **设置面板**(spec 09):MCP server 管理——增/删/改 + 「测试连接」(connect + listTools 预览)。敏感字段(headers 里的 key)按现有 key 管理思路存 DB(不引 keychain,见 CLAUDE.md §5.4)。
- **Agent builder**(spec 10):勾选本 Agent 启用哪些 server(形如 `AVAILABLE_TOOLS` 的多选)。

---

## 9. 影响面 / 需同步的 spec

- `05-adapter-interface` — 三 adapter 的 MCP 接入方式
- `07-tools` — MCP 工具命名空间 + 与内置工具的关系
- `08-db-schema` — `mcp_servers` 表 + `agents.mcpServerIds` 列(需 `pnpm db:push`)
- `10-agent-builder` — Agent 勾选 MCP server
- `09-frontend-architecture` — 设置面板 MCP 管理
- `11-platform` — stdio MCP 子进程的跨平台启动/清理
- `CLAUDE.md §5` — 安全约束新增「外部 MCP 信任模型」(改安全约束需讨论)

---

## 10. 分期建议

| 阶段 | 内容 | 成本 |
|---|---|---|
| **P0** | 数据模型(`mcp_servers` + `agents.mcpServerIds`)+ **claude-code/codex 接线** + 全局 server 配置 + agent 选用 | 中(SDK 已支持,主要接线 + UI) |
| **P1** | **custom 的 MCP 客户端层**(连接 / listTools / 名字空间 / loop 路由 / 清理) | 高(新子系统) |
| **P2** | `ask` 审批门、SSE/OAuth、连接池、危险命令提示 | 中 |

> 即「先让真 agent 平台(claude-code/codex)接上外部 MCP(便宜),再补 custom(贵)」。

---

## 11. 决策记录（已定 2026-06-04;实现仍按 §6 安全约束讨论后进行）

1. **配置模型** → 全局 `mcp_servers` 表 + `agents.mcpServerIds` 引用。define-once-reuse、密钥集中、与 `toolNames` 一致;不用 per-agent 内联。
2. **`ask` 审批粒度** → **per-tool-per-conversation**(见 §6.2):首次调用某工具弹审批,本会话内记住。兼顾安全与可用(每次问太吵、整 server 批太粗)。
3. **custom 是否首版做** → **否**。首版只上 **P0(claude-code/codex 接线 + 数据模型 + UI)**;custom 的 MCP 客户端(P1)等 P0 跑通、安全模型经实践验证后再投入——它成本高、且最受「沙箱被绕过」影响。
4. **stdio 命令白名单** → **不做硬白名单**(MCP server 命令五花八门,枚举不现实)。改为登记时**完整展示 command/args/env** + 要求显式「我信任此 server」确认 + 明确警告「它在沙箱外、以 app 权限运行」。本地单用户场景下「用户登记 = 知情同意」(等价于自己在终端跑),符合 §5.4 不过度加固的取向。
5. **密钥脱敏** → headers/env 密钥**存 DB**(同 `app_settings`,不引 keychain,§5.4);UI **脱敏显示**(只露后几位,列表接口不回明文);并支持值里写 `${ENV_NAME}` 占位以引用 `.env.local`(免在 DB 存明文)。MCP 密钥是 per-server 维度,**不**套用 LLM 的三层 key 优先级。
