import fs from "node:fs";
import path from "node:path";
import { BUILTIN_AGENTS } from "@/db/builtin-agents";
import { getDataDir, getDatabase } from "@/db/client";
import { recoverOrphanedRuns } from "@/server/run-recovery";
import { newConversationId, newWorkspaceId } from "@/shared/ids";

let bootstrapped = false;

export function ensureDatabase() {
  if (bootstrapped) return;
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL,
      description TEXT NOT NULL,
      capabilities TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      adapter_name TEXT NOT NULL,
      model_provider TEXT,
      model_id TEXT,
      api_key TEXT,
      api_base_url TEXT,
      tool_names TEXT NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      is_conductor INTEGER NOT NULL DEFAULT 0,
      supports_vision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mode TEXT NOT NULL,
      agent_ids TEXT NOT NULL,
      pinned_message_ids TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      fs_write_approval_mode TEXT NOT NULL DEFAULT 'review',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      agent_id TEXT REFERENCES agents(id),
      run_id TEXT,
      parts TEXT NOT NULL,
      status TEXT NOT NULL,
      mentioned_agent_ids TEXT NOT NULL,
      parent_message_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      created_by_agent_id TEXT REFERENCES agents(id),
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      parent_artifact_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'sandbox',
      root_path TEXT NOT NULL,
      bound_path TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      trigger_message_id TEXT,
      parent_run_id TEXT,
      status TEXT NOT NULL,
      stage TEXT,
      error TEXT,
      usage TEXT,
      interrupted INTEGER NOT NULL DEFAULT 0,
      error_category TEXT,
      retryable INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conductor_task_results (
      id TEXT PRIMARY KEY,
      conductor_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL,
      summary TEXT,
      child_run_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      error_category TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_approvals (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      approval_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT NOT NULL,
      resolved_by TEXT,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conductor_plans (
      id TEXT PRIMARY KEY,
      conductor_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      plan_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      user_feedback TEXT,
      stage_at_creation TEXT,
      resumed_from_run_id TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS conductor_output_bindings (
      conductor_run_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      producer_task_id TEXT NOT NULL,
      output_key TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (plan_id, producer_task_id, output_key)
    );

    CREATE TABLE IF NOT EXISTS conductor_conflicts (
      id TEXT PRIMARY KEY,
      conductor_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL,
      path TEXT NOT NULL,
      wave INTEGER NOT NULL,
      contributors_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'detected',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_compaction_jobs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      base_summary_id TEXT,
      previous_job_id TEXT,
      result_summary_id TEXT,
      source_start_message_id TEXT NOT NULL,
      source_end_message_id TEXT NOT NULL,
      source_message_count INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      completed_chunk_count INTEGER NOT NULL DEFAULT 0,
      model_provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      error_category TEXT,
      error TEXT,
      retryable INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_context_summaries (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      summary TEXT NOT NULL,
      covered_until_message_id TEXT NOT NULL,
      covered_until_created_at INTEGER NOT NULL,
      source_message_count INTEGER NOT NULL,
      token_estimate INTEGER NOT NULL,
      model_provider TEXT,
      model_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id TEXT PRIMARY KEY,
      anthropic_api_key TEXT,
      anthropic_base_url TEXT,
      openai_api_key TEXT,
      deepseek_api_key TEXT,
      ark_api_key TEXT,
      companion_mode TEXT NOT NULL DEFAULT 'off',
      mobile_device_token TEXT,
      deployment_publish_enabled INTEGER NOT NULL DEFAULT 0,
      deployment_publish_dir TEXT,
      deployment_public_base_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  migrateLegacyTables();
  createIndexes();
  createMessageSearchIndex();
  seedBuiltinAgents();
  seedAppSettings();
  seedWelcomeConversation();

  // P1: Recover orphaned runs from previous process (must be after tables exist)
  bootstrapped = true;
  recoverOrphanedRuns();
}

function createMessageSearchIndex() {
  const db = getDatabase();
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        tokenize = 'trigram'
      );

      CREATE TRIGGER IF NOT EXISTS messages_fts_ai
      AFTER INSERT ON messages
      WHEN new.status != 'streaming'
      BEGIN
        INSERT OR REPLACE INTO messages_fts(rowid, content)
        SELECT new.rowid, GROUP_CONCAT(json_extract(value, '$.content'), ' ')
        FROM json_each(new.parts)
        WHERE json_extract(value, '$.type') = 'text'
        HAVING COUNT(*) > 0;
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_au
      AFTER UPDATE ON messages
      BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
        INSERT OR REPLACE INTO messages_fts(rowid, content)
        SELECT new.rowid, GROUP_CONCAT(json_extract(value, '$.content'), ' ')
        FROM json_each(new.parts)
        WHERE new.status != 'streaming'
          AND json_extract(value, '$.type') = 'text'
        HAVING COUNT(*) > 0;
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_ad
      AFTER DELETE ON messages
      BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
      END;

      INSERT OR REPLACE INTO messages_fts(rowid, content)
      SELECT m.rowid, GROUP_CONCAT(json_extract(j.value, '$.content'), ' ')
      FROM messages m, json_each(m.parts) AS j
      WHERE m.status != 'streaming'
        AND json_extract(j.value, '$.type') = 'text'
      GROUP BY m.rowid;
    `);
  } catch {
    // Search service falls back to JSON text-part LIKE queries when FTS5 is unavailable.
  }
}

export function resetBootstrapForTests() {
  bootstrapped = false;
}

function migrateLegacyTables() {
  migrateLegacyConductorNames();
  migrateLegacyConductorTables();
  renameColumnIfPresent("agents", legacyRoleKey("is_"), "is_conductor");
  renameColumnIfPresent("conductor_task_results", legacyRoleKey("", "_run_id"), "conductor_run_id");
  renameColumnIfPresent("conductor_plans", legacyRoleKey("", "_run_id"), "conductor_run_id");
  renameColumnIfPresent("conductor_output_bindings", legacyRoleKey("", "_run_id"), "conductor_run_id");
  renameColumnIfPresent("conductor_conflicts", legacyRoleKey("", "_run_id"), "conductor_run_id");

  ensureColumn("agents", "avatar", "TEXT NOT NULL DEFAULT '🤖'");
  ensureColumn("agents", "capabilities", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("agents", "api_key", "TEXT");
  ensureColumn("agents", "api_base_url", "TEXT");
  ensureColumn("agents", "is_conductor", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("agents", "supports_vision", "INTEGER NOT NULL DEFAULT 0");

  ensureColumn("conversations", "archived", "INTEGER NOT NULL DEFAULT 0");

  ensureColumn("agent_runs", "error", "TEXT");
  ensureColumn("agent_runs", "started_at", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("agent_runs", "finished_at", "INTEGER");

  ensureColumn("app_settings", "anthropic_base_url", "TEXT");
  ensureColumn("app_settings", "companion_mode", "TEXT NOT NULL DEFAULT 'off'");
  ensureColumn("app_settings", "mobile_device_token", "TEXT");
  ensureColumn("app_settings", "deployment_publish_enabled", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("app_settings", "deployment_publish_dir", "TEXT");
  ensureColumn("app_settings", "deployment_public_base_url", "TEXT");

  getDatabase().exec(`
    UPDATE agent_runs SET started_at = created_at WHERE started_at = 0;
  `);
}

function migrateLegacyConductorTables() {
  migrateLegacyConductorTable("task_results", "conductor_task_results", [
    "id",
    `${legacyRoleKey("", "_run_id")} AS conductor_run_id`,
    "conversation_id",
    "task_id",
    "agent_id",
    "title",
    "status",
    "summary",
    "child_run_id",
    "attempt",
    "error_category",
    "created_at",
    "updated_at"
  ]);
  migrateLegacyConductorTable("plans", "conductor_plans", [
    "id",
    `${legacyRoleKey("", "_run_id")} AS conductor_run_id`,
    "conversation_id",
    "revision",
    "plan_json",
    "status",
    "user_feedback",
    "stage_at_creation",
    "resumed_from_run_id",
    "created_at",
    "resolved_at"
  ]);
  migrateLegacyConductorTable("output_bindings", "conductor_output_bindings", [
    `${legacyRoleKey("", "_run_id")} AS conductor_run_id`,
    "plan_id",
    "producer_task_id",
    "output_key",
    "artifact_id",
    "created_at"
  ]);
  migrateLegacyConductorTable("conflicts", "conductor_conflicts", [
    "id",
    `${legacyRoleKey("", "_run_id")} AS conductor_run_id`,
    "plan_id",
    "path",
    "wave",
    "contributors_json",
    "status",
    "created_at"
  ]);
}

function migrateLegacyConductorTable(legacySuffix: string, tableName: string, selectColumns: string[]) {
  const oldTableName = `${legacyProcessKey()}_${legacySuffix}`;
  if (!tableExists(oldTableName) || !tableExists(tableName)) return;
  getDatabase().exec(`
    INSERT OR IGNORE INTO ${tableName}
    SELECT ${selectColumns.join(", ")}
    FROM ${oldTableName};
    DROP TABLE ${oldTableName};
  `);
}

function createIndexes() {
  const db = getDatabase();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at);
    CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_conv ON attachments(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_runs_parent ON agent_runs(parent_run_id);
    CREATE INDEX IF NOT EXISTS idx_context_summaries_conv_created
      ON conversation_context_summaries(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_cond_task_results_run
      ON conductor_task_results(conductor_run_id);
    CREATE INDEX IF NOT EXISTS idx_pending_approvals_conv
      ON pending_approvals(conversation_id, status);
    CREATE INDEX IF NOT EXISTS idx_pending_approvals_run
      ON pending_approvals(run_id);

    CREATE INDEX IF NOT EXISTS idx_cond_plans_run ON conductor_plans(conductor_run_id);
    CREATE INDEX IF NOT EXISTS idx_cond_bindings_plan ON conductor_output_bindings(plan_id);
    CREATE INDEX IF NOT EXISTS idx_cond_conflicts_run ON conductor_conflicts(conductor_run_id);

    CREATE INDEX IF NOT EXISTS idx_compaction_jobs_conversation
      ON context_compaction_jobs(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_compaction_jobs_status
      ON context_compaction_jobs(status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_compaction_jobs_active
      ON context_compaction_jobs(conversation_id)
      WHERE status IN ('queued', 'running');
  `);

  // P1: Migration for existing DBs that may lack the new columns/table
  try { db.exec(`ALTER TABLE agent_runs ADD COLUMN stage TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE agent_runs ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE agent_runs ADD COLUMN error_category TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE agent_runs ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE conversations ADD COLUMN pinned_at INTEGER`); } catch { /* already exists */ }
  const legacyPinnedRows = db
    .prepare("SELECT id, pinned_message_ids FROM conversations WHERE pinned_message_ids LIKE '%__pinned__%'")
    .all() as Array<{ id: string; pinned_message_ids: string }>;
  for (const row of legacyPinnedRows) {
    let pins: string[] = [];
    try {
      pins = JSON.parse(row.pinned_message_ids) as string[];
    } catch {
      pins = [];
    }
    db.prepare("UPDATE conversations SET pinned_message_ids = ? WHERE id = ?")
      .run(JSON.stringify(pins.filter((id) => id !== "__pinned__")), row.id);
  }
  ensureColumn("context_compaction_jobs", "previous_job_id", "TEXT");
}

function seedBuiltinAgents() {
  const db = getDatabase();
  const now = Date.now();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO agents (
      id, name, avatar, description, capabilities, system_prompt, adapter_name,
      model_provider, model_id, api_key, api_base_url, tool_names, is_builtin,
      is_conductor, supports_vision, created_at, updated_at
    ) VALUES (
      @id, @name, @avatar, @description, @capabilities, @systemPrompt, @adapterName,
      @modelProvider, @modelId, @apiKey, @apiBaseUrl, @toolNames, @isBuiltin,
      @isConductor, @supportsVision, @createdAt, @updatedAt
    )
  `);

  for (const agent of BUILTIN_AGENTS) {
    insert.run({
      ...agent,
      capabilities: JSON.stringify(agent.capabilities),
      toolNames: JSON.stringify(agent.toolNames),
      isBuiltin: agent.isBuiltin ? 1 : 0,
      isConductor: agent.isConductor ? 1 : 0,
      supportsVision: agent.supportsVision ? 1 : 0,
      createdAt: now,
      updatedAt: now
    });
  }

  migrateLegacyBuiltinPrompts(now);
  upgradeBuiltinConductorPrompt(now);

  db.prepare(`
    UPDATE agents
    SET
      name = 'Conductor',
      updated_at = ?
    WHERE id = 'ag_mock_conductor'
      AND is_builtin = 1
      AND name != 'Conductor'
  `).run(now);
}

function migrateLegacyBuiltinPrompts(now: number) {
  const db = getDatabase();
  const legacyProjectNames = [
    String.fromCharCode(65, 103, 101, 110, 116, 72, 117, 98),
    String.fromCharCode(65, 103, 101, 110, 116, 45, 67, 111, 110, 102, 101, 114, 101, 110, 99, 101)
  ];
  const legacyRoleNames = [
    String.fromCharCode(79, 114, 99, 104, 101, 115, 116, 114, 97, 116, 111, 114),
    String.fromCharCode(111, 114, 99, 104, 101, 115, 116, 114, 97, 116, 111, 114)
  ];
  const update = db.prepare(`
    UPDATE agents
    SET system_prompt = ?, updated_at = ?
    WHERE id = ?
      AND is_builtin = 1
      AND system_prompt = ?
  `);

  for (const agent of BUILTIN_AGENTS) {
    const row = db.prepare("SELECT system_prompt FROM agents WHERE id = ? AND is_builtin = 1")
      .get(agent.id) as { system_prompt: string } | undefined;
    if (!row) continue;

    const brandedPrompt = [...legacyProjectNames, ...legacyRoleNames].reduce(
      (prompt, legacyName) => prompt.replaceAll(
        legacyName,
        legacyProjectNames.includes(legacyName) ? "AgentMeld" : "Conductor"
      ),
      row.system_prompt
    );
    const migratedPrompt = hardenLegacyArtifactPromptExamples(brandedPrompt);

    if (migratedPrompt !== row.system_prompt) {
      update.run(migratedPrompt, now, agent.id, row.system_prompt);
    }
  }
}

function hardenLegacyArtifactPromptExamples(prompt: string) {
  return prompt
    .replaceAll(
      "你的核心产出是 PRD（产品需求文档），用 write_artifact(type='document', content={format:'markdown', content:'...'}) 输出。",
      "你的核心产出是 PRD（产品需求文档），用 write_artifact 输出。\n\nwrite_artifact 必须使用严格 JSON 参数：\n{\"type\":\"document\",\"title\":\"...\",\"content\":\"# 标题\\\\n\\\\n正文...\"}\ndocument 的 content 直接放 markdown 字符串，不要写 content: format，也不要嵌套第二个 content 字段。Markdown 换行必须写成 \\\\n。"
    )
    .replaceAll(
      "你的核心产出是「风格指南」（不是图，是结构化的设计描述），用 write_artifact(type='document') 输出。",
      "你的核心产出是「风格指南」（不是图，是结构化的设计描述），用 write_artifact 输出。\n\nwrite_artifact 必须使用严格 JSON 参数：\n{\"type\":\"document\",\"title\":\"...\",\"content\":\"# 标题\\\\n\\\\n正文...\"}\ndocument 的 content 直接放 markdown 字符串，不要写 content: format，也不要嵌套第二个 content 字段。Markdown 换行必须写成 \\\\n。"
    )
    .replaceAll(
      "{\"type\":\"document\",\"title\":\"...\",\"content\":{\"format\":\"markdown\",\"content\":\"# 标题\\\\n\\\\n正文...\"}}\ncontent 必须是对象，不能写成 content: format，也不能把 content 整体作为字符串。Markdown 换行必须写成 \\\\n。",
      "{\"type\":\"document\",\"title\":\"...\",\"content\":\"# 标题\\\\n\\\\n正文...\"}\ndocument 的 content 直接放 markdown 字符串，不要写 content: format，也不要嵌套第二个 content 字段。Markdown 换行必须写成 \\\\n。"
    )
    .replaceAll(
      "只有用户明确要求网页产物、可预览原型、artifact 或独立 demo 时，才用 write_artifact(type='web_app', content={files:{...}, entry:'index.html'}) 输出，然后调用 deploy_artifact 生成本地预览路径。",
      "只有用户明确要求网页产物、可预览原型、artifact 或独立 demo 时，才用 write_artifact 输出，然后调用 deploy_artifact 生成本地预览路径。\n  write_artifact 必须使用严格 JSON 参数：{\"type\":\"web_app\",\"title\":\"...\",\"content\":{\"files\":{\"index.html\":\"...\"},\"entry\":\"index.html\"}}\n  content 必须是对象，不能写成 content: files，也不能把 content 整体作为字符串；源码字符串里的换行必须写成 \\\\n。"
    )
    .replaceAll(
      "当 workspace_info mode=local 且用户要求创建 / 修改 / 初始化 / 调试前端项目、源码文件、依赖或构建配置时，优先使用 fs_read / fs_write / bash 直接操作本地文件并运行验证；不要用 write_artifact 代替应该落盘的源码。构建出 dist/build/out 等静态目录后，可用 deploy_workspace 生成部署预览卡。",
      "当用户要求创建 / 修改 / 初始化 / 调试前端项目、源码文件、依赖或构建配置时，无论 workspace_info mode 是 sandbox 还是 local，都优先使用 fs_list / fs_read / fs_write / bash 直接操作当前 workspace；不要用 write_artifact 代替应该落盘的源码。\n- 当用户要求“部署 / 重新部署 / 发布 / 预览”时，必须在本轮真实调用 deploy_workspace 或 deploy_artifact；不能只根据历史消息回复。deploy_workspace 可以部署任何 workspace 内包含 index.html 的静态目录（如 dist、build、out、public、app 目录或项目根目录），不只限构建输出目录。调用前如不确定路径，先用 fs_list 查找包含 index.html 的目录。\n- 部署流程必须按工具链完成：如果 fs_list 已经看到某个目录下存在 index.html，下一步必须调用 deploy_workspace，参数 path 就填这个目录（例如 \"todo-app\" 或 \".\"）；在 deploy_workspace 返回前不要输出“部署成功”、预览地址、产物 id 或 Markdown 链接。"
    )
    .replaceAll(
      "调用前如不确定路径，先用 fs_list 查找包含 index.html 的目录。\n- 只有用户明确要求网页产物",
      "调用前如不确定路径，先用 fs_list 查找包含 index.html 的目录。\n- 部署流程必须按工具链完成：如果 fs_list 已经看到某个目录下存在 index.html，下一步必须调用 deploy_workspace，参数 path 就填这个目录（例如 \"todo-app\" 或 \".\"）；在 deploy_workspace 返回前不要输出“部署成功”、预览地址、产物 id 或 Markdown 链接。\n- 只有用户明确要求网页产物"
    )
    .replaceAll(
      "content 必须是对象，不能写成 content: files，也不能把 content 整体作为字符串；源码字符串里的换行必须写成 \\\\n。\n\n要求：",
      "content 必须是对象，不能写成 content: files，也不能把 content 整体作为字符串；源码字符串里的换行必须写成 \\\\n。\n- 硬性禁止：没有收到本轮 deploy_workspace / deploy_artifact 的工具返回结果时，不得声称“部署成功 / 已重新部署成功”，不得手写 /deployments/dep_*、art_*、[部署预览: ...] 或 [产物: ...]。部署工具成功后系统会自动生成部署卡和产物卡，最终文字只需简短说明“已完成部署”。\n\n要求："
    )
    .replaceAll(
      "完成 web_app 产物后必须调用 deploy_artifact；完成本地项目构建后优先调用 deploy_workspace。",
      "完成 web_app 产物后必须调用 deploy_artifact；完成本地静态项目或构建目录后优先调用 deploy_workspace。"
    );
}

function upgradeBuiltinConductorPrompt(now: number) {
  const db = getDatabase();
  const conductor = BUILTIN_AGENTS.find((agent) => agent.id === "ag_mock_conductor");
  if (!conductor) return;

  const row = db.prepare("SELECT system_prompt FROM agents WHERE id = ? AND is_builtin = 1")
    .get(conductor.id) as { system_prompt: string } | undefined;
  if (!row || row.system_prompt === conductor.systemPrompt) return;
  if (!isLegacyDefaultConductorPrompt(row.system_prompt)) return;

  db.prepare(`
    UPDATE agents
    SET system_prompt = ?, updated_at = ?
    WHERE id = ?
      AND is_builtin = 1
      AND system_prompt = ?
  `).run(conductor.systemPrompt, now, conductor.id, row.system_prompt);
}

function isLegacyDefaultConductorPrompt(prompt: string) {
  return [
    "你是 AgentMeld 平台的 Conductor（主协调者）。你负责理解用户目标，决定是否需要多 Agent 协作。",
    "分派前根据群聊中 Agent 的能力选择负责人；不要把同一职责重复派给多个 Agent。",
    "产物链路要清楚：PRD -> 风格指南 -> web_app -> review；缺少上游产物时允许跳过或让对应 Agent 补齐。",
    "聚合结果时只总结关键结论、产物位置和下一步决策，不重复每个 Agent 的长篇过程。"
  ].every((marker) => prompt.includes(marker));
}

function seedAppSettings() {
  const now = Date.now();
  getDatabase()
    .prepare(
      `
        INSERT OR IGNORE INTO app_settings (
          id, companion_mode, deployment_publish_enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `
    )
    .run("singleton", "off", 0, now, now);
}

function seedWelcomeConversation() {
  const db = getDatabase();
  const count = db.prepare("SELECT COUNT(*) AS count FROM conversations").get() as { count: number };
  if (count.count > 0) return;

  const now = Date.now();
  const conversationId = newConversationId();
  const workspaceId = newWorkspaceId();
  const workspaceRoot = path.join(getDataDir(), "workspaces", conversationId);
  fs.mkdirSync(workspaceRoot, { recursive: true });

  db.prepare(`
    INSERT INTO conversations (
      id, title, mode, agent_ids, fs_write_approval_mode,
      pinned_message_ids, archived, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    conversationId,
    "AgentMeld MVP 群聊",
    "group",
    JSON.stringify(["ag_mock_conductor", "ag_pm", "ag_designer", "ag_mock_builder", "ag_reviewer"]),
    "auto",
    JSON.stringify([]),
    0,
    now,
    now
  );

  db.prepare(`
    INSERT INTO workspaces (
      id, conversation_id, mode, root_path, bound_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(workspaceId, conversationId, "sandbox", workspaceRoot, null, now, now);
}

function ensureColumn(tableName: string, columnName: string, definition: string) {
  if (columnExists(tableName, columnName)) return;
  getDatabase().exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function renameColumnIfPresent(tableName: string, legacyColumnName: string, columnName: string) {
  if (!columnExists(tableName, legacyColumnName) || columnExists(tableName, columnName)) return;
  getDatabase().exec(`ALTER TABLE ${tableName} RENAME COLUMN ${legacyColumnName} TO ${columnName}`);
}

function columnExists(tableName: string, columnName: string) {
  const columns = getDatabase().prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}

function tableExists(tableName: string) {
  const row = getDatabase()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function migrateLegacyConductorNames() {
  const db = getDatabase();
  const legacyRole = legacyRoleKey();
  const legacyId = `ag_mock_${legacyRole}`;
  const conductorId = "ag_mock_conductor";
  const legacyDisplayName = String.fromCharCode(79, 114, 99, 104, 101, 115, 116, 114, 97, 116, 111, 114);

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.prepare("UPDATE messages SET agent_id = ? WHERE agent_id = ?").run(conductorId, legacyId);
    db.prepare("UPDATE artifacts SET created_by_agent_id = ? WHERE created_by_agent_id = ?").run(conductorId, legacyId);
    db.prepare("UPDATE agent_runs SET agent_id = ? WHERE agent_id = ?").run(conductorId, legacyId);
    db.prepare("UPDATE pending_approvals SET agent_id = ? WHERE agent_id = ?").run(conductorId, legacyId);
    db.prepare("UPDATE conversations SET agent_ids = replace(agent_ids, ?, ?) WHERE agent_ids LIKE ?")
      .run(legacyId, conductorId, `%${legacyId}%`);
    db.prepare("UPDATE agents SET id = ?, name = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM agents WHERE id = ?)")
      .run(conductorId, "Conductor", legacyId, conductorId);
    db.prepare("UPDATE agents SET name = ? WHERE id = ? AND name = ?")
      .run("Conductor", conductorId, legacyDisplayName);
    db.prepare("DELETE FROM agents WHERE id = ? AND EXISTS (SELECT 1 FROM agents WHERE id = ?)")
      .run(legacyId, conductorId);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function legacyRoleKey(prefix = "", suffix = "") {
  return `${prefix}${String.fromCharCode(111, 114, 99, 104, 101, 115, 116, 114, 97, 116, 111, 114)}${suffix}`;
}

function legacyProcessKey() {
  return String.fromCharCode(111, 114, 99, 104, 101, 115, 116, 114, 97, 116, 105, 111, 110);
}
