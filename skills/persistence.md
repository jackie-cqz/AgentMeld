# AgentMeld 持久化系统

> SQLite + Drizzle ORM → 实体存储、迁移、启动恢复。

## 数据库

本地 SQLite（`better-sqlite3` 驱动），文件位于 `.agentmeld-data/`（或无 `AGENTMELD_DATA_DIR` 时项目根目录）。单用户本地场景，文件系统权限 = 安全边界。

## 核心表

| 表 | 用途 |
|------|------|
| `agents` | Agent 配置：adapter、provider、model、key、tools |
| `conversations` | 会话：mode、agentIds、pinnedMessageIds、pinnedAt |
| `messages` | 消息：parts JSON、status、agentId、runId |
| `artifacts` | 产物：type、title、content JSON、version、parentArtifactId |
| `workspaces` | 工作区：mode (sandbox/local)、rootPath |
| `agent_runs` | 运行记录：status、stage、usage、errorCategory、interrupted |
| `app_settings` | 全局设置（单行表）：各 provider key、部署配置 |
| `conversation_context_summaries` | 上下文压缩摘要 |

## 扩展表

| 表 | 用途 |
|------|------|
| `pending_approvals` | 统一审批：fs_write/bash/ask_user/dispatch_plan |
| `orchestration_plans` | Conductor 计划：plan_json、revision、userFeedback |
| `orchestration_task_results` | 任务结果：taskId、status、summary、childRunId |
| `orchestration_output_bindings` | 产物绑定：taskId.outputKey → artifactId |
| `orchestration_conflicts` | 文件冲突：path、wave、contributors_json |
| `context_compaction_jobs` | 压缩任务：status、chunks、error |

## 实体映射

`src/db/rows.ts` 定义 Row 接口和 `mapXxx()` 函数：

```typescript
// DB row → domain type
AgentRow → mapAgent(row) → Agent
ConversationRow → mapConversation(row) → Conversation
RunRow → mapRun(row) → AgentRun
// ...
```

JSON 字段（`parts`, `tool_names`, `plan_json`）存取时自动 parse/serialize。

## 迁移

`src/db/bootstrap.ts` 中 `ensureDatabase()`：
1. `CREATE TABLE IF NOT EXISTS` — 全新安装
2. 末尾 `ALTER TABLE ADD COLUMN` try/catch — 旧 DB 增量迁移
3. `seedBuiltinAgents()` + `seedAppSettings()` + `seedWelcomeConversation()`
4. `recoverOrphanedRuns()` — 启动恢复

## 启动恢复

`src/server/run-recovery.ts` 在每次启动时执行：

```
1. interruptAllPendingApprovals()   → pending → interrupted
2. recoverCompactionJobs()          → queued/running → interrupted
3. listOrphanedRunningRuns()        → 扫描 running 状态的 run
4. markRunInterrupted()             → 标记为 failed + interrupted
5. cancelPendingPlansForRun()       → 清理关联审批
6. clearFileWrites()                → 清理文件写入记录
```

不恢复到 LLM stream 中间。用户可从消息重新执行，Conductor 可从已完成任务之后重新规划。

## 审批持久化

所有审批写入 `pending_approvals` 表，通过 `approval_type` 区分：

```sql
INSERT INTO pending_approvals (id, conversation_id, agent_id, run_id,
  approval_type, status, payload_json, created_at)
VALUES (?, ?, ?, ?, ?, 'pending', ?, ?);

-- 条件更新（防并发重复）
UPDATE pending_approvals
SET status = 'approved', resolved_at = ?
WHERE id = ? AND status = 'pending';
```

Resolver 仍在内存 Promise 中，但 DB 是审计和展示来源。

## 数据目录

```typescript
// src/db/client.ts
const dir = process.env.AGENTMELD_DATA_DIR
  ? path.resolve(process.env.AGENTMELD_DATA_DIR)
  : path.join(process.cwd(), ".agentmeld-data");
```

Workspace 文件、preview、deployment 都在此目录下。

## 相关文件

| 文件 | 内容 |
|------|------|
| `src/db/bootstrap.ts` | 建表 + 迁移 + 种子数据 |
| `src/db/rows.ts` | Row 类型 + map 函数 |
| `src/db/client.ts` | getDatabase() + getDataDir() |
| `src/server/repositories.ts` | CRUD 函数 (createAgent, getConversation, listRuns...) |
| `src/server/run-recovery.ts` | 启动恢复 |
| `src/server/conversation-service.ts` | 会话 + 工作区创建 |
| `src/server/settings-service.ts` | 全局设置存取 |
| `specs/08-db-schema.md` | DB 规格 |
