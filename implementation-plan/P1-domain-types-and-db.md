# P1 - 领域类型与数据库

## 目标

把文档中的核心实体落成共享 TypeScript 类型和 Drizzle/SQLite schema，为后续会话、消息、AgentRun、产物和 workspace 提供稳定持久化基础。

## 参考文件

- `openspec/specs/core-domain/spec.md`
- `openspec/specs/persistence/spec.md`
- `openspec/specs/message-parts/spec.md`
- `openspec/specs/artifacts/spec.md`
- `specs/01-core-entities.md`
- `specs/03-message-parts.md`
- `specs/04-artifacts.md`
- `specs/08-db-schema.md`
- `DEEP-OVERVIEW.md` 的“数据库：9 张表”

## 范围

需要实现：

- `src/shared/types.ts`
- `src/shared/constants.ts`
- `src/db/schema.ts`
- `src/db/client.ts`
- `src/db/bootstrap.ts`
- `src/db/builtin-agents.ts`
- `src/db/seed.ts`
- ID 生成工具

## 数据表

| 表 | MVP 字段重点 |
|---|---|
| `agents` | adapter、provider、model、prompt、tools、api key/base url |
| `conversations` | title、mode、agent ids、approval mode、pinned ids |
| `messages` | role、agent id、parts、status、run id、usage |
| `artifacts` | type、title、content、version、parent id |
| `workspaces` | mode、root path、bound path |
| `attachments` | kind、file path、mime、size |
| `agent_runs` | status、trigger message、parent run、usage |
| `conversation_context_summaries` | summary、covered message |
| `app_settings` | provider keys、deployment settings |

## 任务拆分

1. 定义 `AdapterName`、`ModelProvider`、`Agent`、`Conversation` 等核心类型。
2. 定义 `MessagePart` 判别联合。
3. 定义 `ArtifactContent` 判别联合。
4. 定义 `StreamEvent` 的基础类型占位，P2 继续补完整事件。
5. 定义 Drizzle schema，JSON 列使用 `$type<T>()`。
6. 实现 `.agent-conference-data` 数据目录解析。
7. 实现数据库 bootstrap 和内置 seed。
8. 写基础测试：ID 前缀、seed 幂等、conversation/workspace 关系。

## 验收标准

- 首次运行能创建 `.agent-conference-data/agent-conference.db`。
- 所有表可创建。
- Seed 后至少存在 Mock agent、Custom agent、Orchestrator。
- 新建 conversation 时能创建 workspace。
- TypeScript 类型和 DB JSON 列对应。

## 风险

- SQLite native binding 可能因 pnpm build scripts 未批准而不可用。
- Specs 中部分 artifact 类型有历史演化，MVP 以 `specs/04-artifacts.md` 当前版本为准。
