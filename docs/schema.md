# 数据库 Schema：单一事实来源

本文说明 AgentMeld 的数据库结构由谁定义、`src/db/schema.ts` 扮演什么角色，以及修改表结构时必须遵守的流程。

## 结论

| 文件 | 角色 | 是否影响真实数据库 |
| --- | --- | --- |
| `src/db/bootstrap.ts` | **运行时权威（runtime authority）**，用原生 SQL 执行全部 DDL | 是。应用启动时 `ensureDatabase()` 真正建表 / 升级表 |
| `src/db/schema.ts` | **类型镜像（typed mirror）**，与 bootstrap 保持一致 | 否。生产代码不导入它，仅供类型 / 工具使用 |
| `src/db/schema-drift.test.ts` | **漂移守卫（drift guard）**，强制两者一致 | 否。测试用临时库对比，失败时给出具体差异 |

一句话：**bootstrap.ts 定义数据库，schema.ts 描述数据库，drift 测试保证二者不会悄悄分叉。**

## 运行时权威：`src/db/bootstrap.ts`

- `ensureDatabase()` 在应用启动时执行，是用户数据库被创建和升级的唯一真实路径。
- 它用 `CREATE TABLE IF NOT EXISTS` 创建全部 **22 张业务表**，覆盖：
  - 核心表：`agents`、`conversations`、`messages`、`artifacts`、`workspaces`、`attachments`、`agent_runs`、`conversation_context_summaries`、`app_settings`；
  - Conductor / 审批 / 压缩：`conductor_task_results`、`pending_approvals`、`conductor_plans`、`conductor_output_bindings`、`conductor_conflicts`、`context_compaction_jobs`；
  - P1 证据与上下文：`task_attempts`、`task_context_snapshots`、`task_evidence`、`criterion_verdicts`；
  - P2 Fact Registry：`conversation_fact_definitions`、`conversation_facts`、`conversation_fact_sources`。
- 对**已存在**的旧数据库，它通过 `ensureColumn()` 和若干 `ALTER TABLE ... ADD COLUMN`（带 `try/catch`）做幂等升级。因此有些列只出现在 ALTER 路径里，例如 `agent_runs.stage/interrupted/error_category/retryable`、`conversations.pinned_at`、`context_compaction_jobs.previous_job_id`、`conversation_fact_definitions.value_json`。这些列同样是真实 schema 的一部分，必须出现在镜像里。
- 它还会创建索引、FTS5 全文检索虚拟表（`messages_fts`、`context_fts_messages`、`context_fts_tasks` 及其 SQLite 内部 shadow 表）以及触发器。**FTS 表属于搜索功能的实现细节，不是业务数据模型**，因此不写入 `schema.ts`；drift 测试会显式排除它们，并单独校验这三个检索根表仍然存在。

## 类型镜像：`src/db/schema.ts`

- 用 Drizzle ORM 声明与 bootstrap **完全一致**的 22 张表：列名、类型、可空性、默认值、JSON 列（`text("col", { mode: "json" }).$type<T>()`）、外键 / `REFERENCES ... ON DELETE CASCADE`，以及 DDL 声明的唯一约束和索引。
- 它不参与运行时建表，生产代码也不导入它。它存在的价值是：为未来可能的 Drizzle 查询 / 工具提供类型入口，并让 schema 差异可被自动检测。

## 漂移守卫：`src/db/schema-drift.test.ts`

测试流程：

1. 用 `src/test/test-database.ts` 的 `setupTestDatabase()` 创建临时 data dir、设置 `AGENTMELD_DATA_DIR`、重置 bootstrap / DB 状态；
2. 调用 `ensureDatabase()`，从 SQLite 真实读取 `sqlite_master` 的表和 `PRAGMA table_info()` 的列；
3. 用 `getTableConfig()`（`drizzle-orm/sqlite-core`）读取 `schema.ts` 的表和列；
4. 断言**表名集合相等**、**每张表的列名集合相等**，失败信息会直接列出「schema.ts 缺少 / 多出」的具体表名或列名。

规则：只要 bootstrap 加了表 / 列而 schema.ts 没跟上（或反过来），这个测试就会失败，并在报错里指出要补什么。

## 开发者规则

**新增或修改表 / 列时，必须同时修改两处：**

1. **`src/db/bootstrap.ts`**
   - 在 `CREATE TABLE IF NOT EXISTS` 里补上列（保证全新数据库正确）；
   - 对已有数据库，再加上幂等的 `ensureColumn("table", "col", "TYPE ...")`，或用 `try { db.exec("ALTER TABLE ... ADD COLUMN ...") } catch {}`（保证老库在启动时能升级，行为必须幂等）。
2. **`src/db/schema.ts`**
   - 补上对应的 Drizzle 声明，保持列名、类型、可空性、默认值、JSON mode、外键、唯一约束 / 索引一致。
3. **验证**
   - `npx vitest run src/db/schema-drift.test.ts`
   - `npx tsc --noEmit`
   - `npx eslint .`

注意：镜像方向永远是 **bootstrap → schema.ts**。不要为了迁就 schema.ts 去改 bootstrap 的 DDL 行为。

## `pnpm db:push` 的实际行为与安全边界

`pnpm db:push` 即 `drizzle-kit push`，读取 `drizzle.config.ts`：

- **连接哪个库**：与应用一致，通过 `AGENTMELD_DATA_DIR` 解析到 `<AGENTMELD_DATA_DIR>/agentmeld.db`，默认 `.agentmeld-data/agentmeld.db`。运行时只认 `AGENTMELD_DATA_DIR`，不读 `AGENTMELD_DB_PATH`；配置里只有在 `AGENTMELD_DB_PATH` 解析结果与应用路径**完全相同**时才接受，否则直接报错，避免 drizzle-kit 连到另一个库。`out: "./drizzle"` 保留为将来生成迁移的输出目录。
- **什么时候安全**：仅适用于**全新的空数据库**。此时它按 `schema.ts` 建出全部 22 张表（已验证）。
- **什么时候不安全**：对应用已经启动过、由 bootstrap 创建过的数据库运行 `db:push` **不是幂等的，也可能破坏数据**。因为 `schema.ts` 有意不声明 FTS 虚拟表，drizzle-kit 会把它们识别为「多余表」并生成 `DROP TABLE`；DDL 写法的差异还会触发多张表的 `__new_*` 重建。因此：
  - 不要在用户/真实数据库上运行 `db:push`，尤其不要加 `--force`；
  - 需要创建或升级数据库时，**直接启动应用**让 `ensureDatabase()` 处理，这是官方且安全的路径。
- **没有生成式迁移**：仓库里没有 `drizzle/` 目录，也没有任何 `.sql` 迁移文件和历史记录；`drizzle-kit generate` 目前不在工作流内。schema 变更靠 bootstrap 的幂等 DDL / ALTER 在启动时完成，而不是靠迁移文件。
