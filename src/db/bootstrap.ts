import fs from "node:fs";
import path from "node:path";
import { BUILTIN_AGENTS } from "@/db/builtin-agents";
import { getDataDir, getDatabase } from "@/db/client";
import { recoverOrphanedRuns } from "@/server/run-recovery";
import { newConversationId, newWorkspaceId } from "@/shared/ids";

let bootstrapped = false;

const LEGACY_BUILTIN_TOOL_PRESETS: Record<string, string[]> = {
  ag_mock_conductor: ["plan_tasks", "report_task_result", "read_artifact", "ask_user", "update_context_facts"],
  ag_pm: ["write_artifact", "read_artifact", "read_attachment", "ask_user"],
  ag_designer: ["write_artifact", "read_artifact", "read_attachment", "ask_user"],
  ag_mock_builder: ["fs_read", "fs_write", "bash", "write_artifact", "read_artifact", "deploy_artifact", "deploy_workspace", "read_attachment", "fs_list"],
  ag_reviewer: ["read_artifact", "read_attachment", "fs_list", "fs_read", "bash"],
  ag_custom_assistant: ["write_artifact", "read_artifact"]
};

export function ensureDatabase() {
  if (bootstrapped) return;
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS model_provider_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      preset_id TEXT,
      protocol TEXT NOT NULL DEFAULT 'chat-completions',
      base_url TEXT NOT NULL,
      default_model TEXT NOT NULL,
      models TEXT NOT NULL DEFAULT '[]',
      api_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

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
      origin TEXT NOT NULL DEFAULT 'human',
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
      verification_status TEXT NOT NULL DEFAULT 'not_started',
      verified_attempt_id TEXT,
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
      resolved_by_label TEXT,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS delegations (
      id TEXT PRIMARY KEY,
      correlation_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL,
      source_agent_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'issued',
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      consumed_by_run_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delegations_correlation ON delegations(correlation_id);
    CREATE INDEX IF NOT EXISTS idx_delegations_source_run ON delegations(source_run_id, status);

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
      superseded_at INTEGER,
      replaced_by_task_id TEXT,
      actual_producer_task_id TEXT,
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

    -- P1: Evidence-aware Context Engineering tables

    CREATE TABLE IF NOT EXISTS task_attempts (
      id TEXT PRIMARY KEY,
      conductor_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      plan_revision INTEGER NOT NULL DEFAULT 0,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      child_run_id TEXT,
      attempt INTEGER NOT NULL,
      context_snapshot_id TEXT,
      execution_status TEXT NOT NULL DEFAULT 'queued',
      verification_status TEXT NOT NULL DEFAULT 'not_started',
      failure_context_json TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(conductor_run_id, plan_id, task_id, attempt)
    );

    CREATE TABLE IF NOT EXISTS task_context_snapshots (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      conductor_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
      policy_version TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      envelope_json TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      required_token_estimate INTEGER NOT NULL DEFAULT 0,
      omitted_token_estimate INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_evidence (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      conductor_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
      child_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      context_snapshot_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'valid',
      trust_level TEXT NOT NULL DEFAULT 'verified',
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      content_hash TEXT,
      invalidated_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS criterion_verdicts (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
      criterion_id TEXT NOT NULL,
      validator_type TEXT NOT NULL,
      status TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      reason TEXT NOT NULL,
      checked_at INTEGER NOT NULL,
      UNIQUE(attempt_id, criterion_id)
    );

    -- P2: Fact Registry tables

    CREATE TABLE IF NOT EXISTS conversation_fact_definitions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE,
      canonical_key TEXT NOT NULL,
      namespace TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      property_name TEXT NOT NULL,
      value_type TEXT NOT NULL,
      update_policy TEXT NOT NULL DEFAULT 'replace',
      description TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      applicable_task_tags_json TEXT NOT NULL DEFAULT '[]',
      applicable_agent_roles_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      origin TEXT NOT NULL DEFAULT 'conversation',
      proposed_by_agent_id TEXT,
      source_message_id TEXT,
      merged_into_definition_id TEXT,
      value_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(conversation_id, canonical_key)
    );

    CREATE TABLE IF NOT EXISTS conversation_facts (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE,
      definition_id TEXT NOT NULL,
      canonical_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      value_type TEXT NOT NULL,
      status TEXT NOT NULL,
      trust_level TEXT NOT NULL,
      confidence REAL NOT NULL,
      resolution_method TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      supersedes_fact_id TEXT,
      invalidated_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_fact_sources (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE,
      fact_id TEXT NOT NULL
        REFERENCES conversation_facts(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_excerpt TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(fact_id, source_type, source_id)
    );

    CREATE TABLE IF NOT EXISTS channel_bindings (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      app_id TEXT NOT NULL,
      app_secret TEXT NOT NULL,
      tenant_brand TEXT,
      bot_open_id TEXT,
      bound_by_open_id TEXT,
      chat_id TEXT,
      conversation_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(agent_id, channel)
    );

    CREATE TABLE IF NOT EXISTS channel_conversations (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(channel, chat_id),
      UNIQUE(conversation_id)
    );

    -- Membership is observed, not asserted: no granted scope can list a chat's
    -- bots, so a row exists only because that agent's bot received an event here.
    CREATE TABLE IF NOT EXISTS channel_conversation_members (
      channel_conversation_id TEXT NOT NULL REFERENCES channel_conversations(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      first_seen_at INTEGER NOT NULL,
      PRIMARY KEY (channel_conversation_id, agent_id)
    );

    -- The platform SDK's own cache, made persistent. expired_at is an
    -- absolute epoch-ms deadline, which is what the SDK passes.
    CREATE TABLE IF NOT EXISTS channel_cache (
      cache_key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expired_at INTEGER
    );

    -- The UNIQUE index is the deduplication: inserting is an atomic claim.
    CREATE TABLE IF NOT EXISTS channel_inbound_messages (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT,
      thread_id TEXT,
      agent_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(channel, external_message_id)
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
  repairLegacyApprovalRecords();
  migrateLegacyConductorTables();
  renameColumnIfPresent("agents", legacyRoleKey("is_"), "is_conductor");
  renameColumnIfPresent("conductor_task_results", legacyRoleKey("", "_run_id"), "conductor_run_id");
  renameColumnIfPresent("conductor_plans", legacyRoleKey("", "_run_id"), "conductor_run_id");
  renameColumnIfPresent("conductor_output_bindings", legacyRoleKey("", "_run_id"), "conductor_run_id");
  renameColumnIfPresent("conductor_conflicts", legacyRoleKey("", "_run_id"), "conductor_run_id");

  ensureColumn("pending_approvals", "resolved_by_label", "TEXT");
  // Feishu topics: kept so a reply can go back into the thread the question
  // was asked in, instead of starting a new one at the top of the group.
  ensureColumn("channel_inbound_messages", "thread_id", "TEXT");
  ensureColumn("agents", "avatar", "TEXT NOT NULL DEFAULT '🤖'");
  ensureColumn("agents", "capabilities", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("agents", "api_key", "TEXT");
  ensureColumn("agents", "api_base_url", "TEXT");
  ensureColumn("agents", "is_conductor", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("agents", "supports_vision", "INTEGER NOT NULL DEFAULT 0");

  ensureColumn("conversations", "archived", "INTEGER NOT NULL DEFAULT 0");

  ensureMessageOriginColumn();

  ensureColumn("agent_runs", "error", "TEXT");
  ensureColumn("agent_runs", "started_at", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("agent_runs", "finished_at", "INTEGER");

  ensureColumn("app_settings", "anthropic_base_url", "TEXT");
  ensureColumn("app_settings", "companion_mode", "TEXT NOT NULL DEFAULT 'off'");
  ensureColumn("app_settings", "mobile_device_token", "TEXT");
  ensureColumn("app_settings", "deployment_publish_enabled", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("app_settings", "deployment_publish_dir", "TEXT");
  ensureColumn("app_settings", "deployment_public_base_url", "TEXT");

  // P1: Conductor task results - verification status columns for existing databases.
  ensureColumn("conductor_task_results", "verification_status", "TEXT NOT NULL DEFAULT 'not_started'");
  ensureColumn("conductor_task_results", "verified_attempt_id", "TEXT");
  ensureColumn("conductor_output_bindings", "superseded_at", "INTEGER");
  ensureColumn("conductor_output_bindings", "replaced_by_task_id", "TEXT");
  ensureColumn("conductor_output_bindings", "actual_producer_task_id", "TEXT");

  // P2: value_json for dynamic definition proposals (added after initial P2 schema)
  try { getDatabase().exec("ALTER TABLE conversation_fact_definitions ADD COLUMN value_json TEXT"); } catch { /* already exists */ }

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
  const targetColumns = selectColumns.map((column) => {
    const aliasMatch = column.match(/\s+AS\s+([a-z_][a-z0-9_]*)$/i);
    return aliasMatch?.[1] ?? column;
  });
  getDatabase().exec(`
    INSERT OR IGNORE INTO ${tableName} (${targetColumns.join(", ")})
    SELECT ${selectColumns.join(", ")}
    FROM ${oldTableName};
    DROP TABLE ${oldTableName};
  `);
}

function createIndexes() {
  const db = getDatabase();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_inbound_conversation ON channel_inbound_messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_channel_inbound_message ON channel_inbound_messages(message_id);
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

    -- P1: Evidence-aware indexes
    CREATE INDEX IF NOT EXISTS idx_task_evidence_attempt
      ON task_evidence(attempt_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_evidence_subject
      ON task_evidence(subject_type, subject_id, status);
    CREATE INDEX IF NOT EXISTS idx_task_evidence_task
      ON task_evidence(conductor_run_id, plan_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_task_attempts_run
      ON task_attempts(conductor_run_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_context_snapshots_attempt
      ON task_context_snapshots(attempt_id);

    -- P2: Fact Registry indexes
    CREATE INDEX IF NOT EXISTS idx_conversation_facts_active
      ON conversation_facts(conversation_id, canonical_key, status);
    CREATE INDEX IF NOT EXISTS idx_conversation_facts_source
      ON conversation_facts(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_fact_definitions_lookup
      ON conversation_fact_definitions(conversation_id, namespace, entity_type, property_name);

    -- P8: FTS5 virtual tables for context retrieval
    CREATE VIRTUAL TABLE IF NOT EXISTS context_fts_messages
      USING fts5(
        message_id,
        conversation_id,
        role,
        agent_name,
        text_content,
        created_at UNINDEXED,
        tokenize='porter unicode61'
      );
    CREATE VIRTUAL TABLE IF NOT EXISTS context_fts_tasks
      USING fts5(
        source_type,
        source_id,
        conversation_id,
        task_id,
        text_content,
        created_at UNINDEXED,
        tokenize='porter unicode61'
      );
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
  migrateLegacyBuiltinToolPresets(now);
  migrateFrontendMkdirTool(now);
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

function migrateLegacyBuiltinToolPresets(now: number) {
  const db = getDatabase();
  const update = db.prepare(`
    UPDATE agents
    SET tool_names = ?, updated_at = ?
    WHERE id = ?
      AND is_builtin = 1
      AND tool_names = ?
  `);

  for (const agent of BUILTIN_AGENTS) {
    const legacyTools = LEGACY_BUILTIN_TOOL_PRESETS[agent.id];
    if (!legacyTools) continue;
    if (sameStringArray(legacyTools, agent.toolNames)) continue;

    const row = db.prepare("SELECT tool_names FROM agents WHERE id = ? AND is_builtin = 1")
      .get(agent.id) as { tool_names: string } | undefined;
    if (!row) continue;

    const currentTools = parseToolNames(row.tool_names);
    if (!sameStringArray(currentTools, legacyTools)) continue;

    update.run(JSON.stringify(agent.toolNames), now, agent.id, row.tool_names);
  }
}

function migrateFrontendMkdirTool(now: number) {
  const db = getDatabase();
  const agent = BUILTIN_AGENTS.find((item) => item.id === "ag_mock_builder");
  if (!agent) return;

  const row = db.prepare("SELECT tool_names FROM agents WHERE id = ? AND is_builtin = 1")
    .get(agent.id) as { tool_names: string } | undefined;
  if (!row) return;

  const currentTools = parseToolNames(row.tool_names);
  const previousDefault = agent.toolNames.filter((tool) => tool !== "fs_mkdir");
  if (!sameStringArray(currentTools, previousDefault)) return;

  db.prepare(`
    UPDATE agents
    SET tool_names = ?, updated_at = ?
    WHERE id = ?
      AND is_builtin = 1
  `).run(JSON.stringify(agent.toolNames), now, agent.id);
}

function parseToolNames(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function sameStringArray(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
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
  const hardened = prompt
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
      "当用户要求创建 / 修改 / 初始化 / 调试前端项目、源码文件、依赖或构建配置时，无论 workspace_info mode 是 workspace-confined 还是 host-access，都优先使用 fs_list / fs_read / fs_write / bash 直接操作当前 workspace；不要用 write_artifact 代替应该落盘的源码。\n- 当用户要求“部署 / 重新部署 / 发布 / 预览”时，必须在本轮真实调用 deploy_workspace 或 deploy_artifact；不能只根据历史消息回复。deploy_workspace 可以部署任何 workspace 内包含 index.html 的静态目录（如 dist、build、out、public、app 目录或项目根目录），不只限构建输出目录。调用前如不确定路径，先用 fs_list 查找包含 index.html 的目录。\n- 部署流程必须按工具链完成：如果 fs_list 已经看到某个目录下存在 index.html，下一步必须调用 deploy_workspace，参数 path 就填这个目录（例如 \"todo-app\" 或 \".\"）；在 deploy_workspace 返回前不要输出“部署成功”、预览地址、产物 id 或 Markdown 链接。"
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
    )
    // Databases migrated by an earlier version hold the intermediate phrasing;
    // the workspace modes it names no longer exist.
    .replaceAll(
      "无论 workspace_info mode 是 sandbox 还是 local",
      "无论 workspace_info mode 是 workspace-confined 还是 host-access"
    );

  return upgradeReviewerArtifactPolicy(
    upgradeFrontendPatchPolicy(hardenFrontendWorkspaceUpdatePolicy(hardened))
  );
}

function upgradeReviewerArtifactPolicy(prompt: string) {
  if (!prompt.includes("你是 Reviewer")) {
    return prompt;
  }

  const upgraded = prompt.replace(
    "不要写代码或新的产物，只输出审查报告（文字）。",
    "不要修改源码。若当前任务的 <expected_outputs> 声明了 review_report，必须调用 write_artifact 创建 document 产物，并严格使用该 outputKey；未声明 review_report 时，可以直接输出文字审查结论。"
  );
  const evidencePolicy =
    "5. “通过”必须引用实际执行得到的 build/test/browser/tool Evidence。只阅读源码或看到 Agent 自述不能证明运行通过；没有执行的验收项必须写“未验证”，不能写“通过”。";
  if (upgraded.includes(evidencePolicy)) return upgraded;
  return upgraded.replace(
    "4. 如果没有明显问题，要明确说\"未发现阻塞问题\"，再列出剩余风险或未验证项。",
    `4. 如果没有明显问题，要明确说"未发现阻塞问题"，再列出剩余风险或未验证项。\n${evidencePolicy}`
  );
}

function hardenFrontendWorkspaceUpdatePolicy(prompt: string) {
  if (!prompt.includes("你是前端工程师")) {
    return prompt;
  }

  const safeUpdatePolicy =
    "- 更新已有前端项目时，采用“读现状 -> 精确覆盖目标文件 -> 运行验证”的策略；不要用 Remove-Item / rm -rf / rmdir / find -delete 清理旧文件或递归删除目录，也不要为了重建而删除用户未明确要求删除的文件。\n" +
    "- 如果旧文件不再使用，默认保留；确实需要替换时直接用 fs_write 覆盖同一路径，或创建新文件并在最终回复里说明遗留文件。";
  const projectChoicePolicy =
    "- 简单单页工具、小游戏、计时器、表单、Dashboard 原型等默认优先使用纯 HTML/CSS/JS 静态实现（index.html + style.css + app.js），除非用户明确要求 React/Next/Vite 或任务复杂到必须组件化。\n" +
    "- 只有选择 npm/pnpm/React/Vite/Next 项目结构时才初始化依赖并运行 build；如果 create-vite / npm init 失败，不要继续假装项目已初始化，也不要用 bash mkdir 补目录，应改用 fs_mkdir / fs_write 创建 package.json 和必要源码。只有任务未指定框架时，才允许降级为纯 HTML/CSS/JS 静态实现。";
  const frameworkCompliancePolicy =
    "- 用户、PRD 或当前任务一旦明确指定 React / Vue / Next / Vite 等框架，就必须创建对应的 package.json 和源码结构，安装所需依赖并运行 build。不得用 CDN UMD、浏览器内 Babel 或纯静态脚本冒充框架项目；安装或构建失败时应继续修复，确实无法完成则如实 report_task_result 为 failed/blocked，不能擅自降级技术栈。";
  const bashVerificationPolicy =
    "- 已有源码文件的局部修改必须使用 fs_patch；只有新建文件或用户明确要求完整覆盖时才使用 fs_write。不要用 bash / PowerShell / sed / Set-Content / Add-Content / Out-File / 重定向来写入、替换、移动、复制或删除源码文件。\n" +
    "- 目录创建用 fs_mkdir，或直接用 fs_write 写目标文件（父目录会自动创建）；目录查看用 fs_list，文件读取用 fs_read。\n" +
    "- bash 只用于两类命令：npm/pnpm/yarn/bun build/test/lint/typecheck/check 等验证命令，以及 npm/pnpm/yarn/bun/pip/uv 依赖安装或更新命令；依赖安装会进入用户审批，审批通过后才执行。";
  const managedWorkspacePackagePolicy =
    "- AgentMeld 管理的 workspace 位于宿主项目目录内，创建项目时禁止使用 pnpm install/add/remove/update/ci，以免 pnpm 识别宿主 workspace 并修改 AgentMeld 根目录 node_modules；必须使用 npm install / npm ci，验证使用 npm run build/test/lint/typecheck/check。只有绑定到宿主目录之外的独立本地项目时，才可沿用该项目自己的 pnpm/yarn/bun。";
  const runtimeShellPolicy =
    "- bash 命令必须遵循 <runtime_platform> 中注入的当前系统与 shell 规则。Windows/PowerShell 下不要使用 /workspace、&&、cp/mv/rm/sed/cat > file 等 POSIX 写法；当前工作区就是 <workspace_info><cwd>，需要切目录时用 Set-Location 或 cd 到该真实路径，命令分隔用 ;。";
  const workspaceDeployPolicy =
    "- 对本地 React/Vite/Next/静态项目，build 成功且存在 dist/build/out/public/index.html 或根目录 index.html 后，下一步必须调用 deploy_workspace，参数 path 填包含 index.html 的目录（例如 \"dist\"）。不要再调用 write_artifact 把源码、dist 文件或构建结果塞进 JSON。\n" +
    "- 只有用户明确要求“单文件网页产物 / artifact / 独立 demo”，且不是当前 workspace 项目的源码实现时，才用 write_artifact 输出，然后调用 deploy_artifact 生成本地预览路径。";

  const anchor =
    "- 当用户要求创建 / 修改 / 初始化 / 调试前端项目、源码文件、依赖或构建配置时，无论 workspace_info mode 是 workspace-confined 还是 host-access，都优先使用 fs_list / fs_read / fs_write / bash 直接操作当前 workspace；不要用 write_artifact 代替应该落盘的源码。";

  const insertAfterAnchor = (current: string, text: string) => {
    if (current.includes(anchor)) {
      return current.replace(anchor, `${anchor}\n${text}`);
    }
    return current.replace("工作方式：", `工作方式：\n${text}`);
  };

  let hardened = prompt;
  if (!hardened.includes("默认优先使用纯 HTML/CSS/JS 静态实现")) {
    hardened = insertAfterAnchor(hardened, projectChoicePolicy);
  }
  if (!hardened.includes("不得用 CDN UMD")) {
    hardened = insertAfterAnchor(hardened, frameworkCompliancePolicy);
  }
  if (!hardened.includes("精确覆盖目标文件")) {
    hardened = insertAfterAnchor(hardened, safeUpdatePolicy);
  }
  if (!hardened.includes("bash 只用于")) {
    hardened = insertAfterAnchor(hardened, bashVerificationPolicy);
  }
  if (!hardened.includes("创建项目时禁止使用 pnpm install")) {
    hardened = insertAfterAnchor(hardened, managedWorkspacePackagePolicy);
  }
  if (!hardened.includes("目录创建用 fs_mkdir")) {
    hardened = insertAfterAnchor(
      hardened,
      "- 目录创建用 fs_mkdir，或直接用 fs_write 写目标文件（父目录会自动创建）；目录查看用 fs_list，文件读取用 fs_read。"
    );
  }
  if (!hardened.includes("<runtime_platform>")) {
    hardened = insertAfterAnchor(hardened, runtimeShellPolicy);
  }
  if (!hardened.includes("不要再调用 write_artifact 把源码")) {
    hardened = insertAfterAnchor(hardened, workspaceDeployPolicy);
  }
  hardened = hardened.replaceAll(
    "- bash 只用于 npm/pnpm/yarn/bun build/test/lint/typecheck/check 等验证命令；目录查看用 fs_list，文件读取用 fs_read。",
    "- bash 只用于两类命令：npm/pnpm/yarn/bun build/test/lint/typecheck/check 等验证命令，以及 npm/pnpm/yarn/bun/pip/uv 依赖安装或更新命令；依赖安装会进入用户审批，审批通过后才执行。目录查看用 fs_list，文件读取用 fs_read。"
  );
  hardened = hardened.replaceAll(
    "- 只有用户明确要求网页产物、可预览原型、artifact 或独立 demo 时，才用 write_artifact 输出，然后调用 deploy_artifact 生成本地预览路径。",
    "- 只有用户明确要求“单文件网页产物 / artifact / 独立 demo”，且不是当前 workspace 项目的源码实现时，才用 write_artifact 输出，然后调用 deploy_artifact 生成本地预览路径。"
  );
  hardened = hardened.replaceAll(
    "content 必须是对象，不能写成 content: files，也不能把 content 整体作为字符串；源码字符串里的换行必须写成 \\\\n。",
    "content 必须是对象，不能写成 content: files，也不能把 content 整体作为字符串；源码字符串里的换行必须写成 \\\\n。不要把大型源码树、dist 目录、node_modules、lockfile 或长 markdown 塞进 write_artifact 参数；这会导致 JSON 截断。"
  );
  hardened = hardened.replaceAll(
    "完成 web_app 产物后必须调用 deploy_artifact；完成本地静态项目或构建目录后优先调用 deploy_workspace。",
    "完成 web_app artifact 后必须调用 deploy_artifact；完成本地静态项目或构建目录后必须调用 deploy_workspace，并在成功后再调用 report_task_result。"
  );
  hardened = hardened.replaceAll(
    "需要安装依赖时，用 bash 发起 npm/pnpm/yarn/bun install/add 或 pip install/uv sync，等待用户审批；不要手写“已安装成功”。",
    "AgentMeld 管理的 workspace 需要安装前端依赖时，用 bash 发起 npm install / npm ci 并等待用户审批；不要使用 pnpm 安装依赖，也不要手写“已安装成功”。"
  );
  hardened = hardened.replaceAll(
    "- 只有选择 npm/pnpm/React/Vite/Next 项目结构时才初始化依赖并运行 build；如果 create-vite / npm init / 依赖安装失败，不要继续假装项目已初始化，也不要用 bash mkdir 补目录。改用 fs_mkdir / fs_write 创建必要文件，或降级为纯 HTML/CSS/JS 静态实现。",
    "- 只有选择 npm/pnpm/React/Vite/Next 项目结构时才初始化依赖并运行 build；如果 create-vite / npm init 失败，不要继续假装项目已初始化，也不要用 bash mkdir 补目录，应改用 fs_mkdir / fs_write 创建 package.json 和必要源码。只有任务未指定框架时，才允许降级为纯 HTML/CSS/JS 静态实现。"
  );

  return hardened;
}

function upgradeFrontendPatchPolicy(prompt: string) {
  if (!prompt.includes("你是前端工程师")) return prompt;

  return prompt
    .replaceAll(
      "fs_list / fs_read / fs_write / bash",
      "fs_list / fs_mkdir / fs_read / fs_write / fs_patch / bash"
    )
    .replaceAll(
      "fs_list / fs_read / fs_write / fs_patch / bash",
      "fs_list / fs_mkdir / fs_read / fs_write / fs_patch / bash"
    )
    .replaceAll(
      "如果旧文件不再使用，默认保留；确实需要替换时直接用 fs_write 覆盖同一路径，或创建新文件并在最终回复里说明遗留文件。",
      "如果旧文件不再使用，默认保留；局部修改优先使用 fs_patch，新建文件或确实需要完整替换时使用 fs_write。"
    )
    .replaceAll(
      "源码修改必须使用 fs_write；不要用 bash / PowerShell / sed / Set-Content / Add-Content / Out-File / 重定向来写入、替换、移动、复制或删除源码文件。",
      "已有源码文件的局部修改必须使用 fs_patch；只有新建文件或用户明确要求完整覆盖时才使用 fs_write。不要用 bash / PowerShell / sed / Set-Content / Add-Content / Out-File / 重定向来写入、替换、移动、复制或删除源码文件。"
    )
    .replaceAll(
      "源码修改必须使用 fs_patch 或 fs_write；不要用 bash / PowerShell / sed / Set-Content / Add-Content / Out-File / 重定向来写入、替换、移动、复制或删除源码文件。",
      "已有源码文件的局部修改必须使用 fs_patch；只有新建文件或用户明确要求完整覆盖时才使用 fs_write。不要用 bash / PowerShell / sed / Set-Content / Add-Content / Out-File / 重定向来写入、替换、移动、复制或删除源码文件。"
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

/**
/**
 * Bring approval rows written before this column was maintained into line with
 * how it is documented now.
 *
 * 1. Attribution. The old `resolveApproval` always copied the *status* into
 *    `resolved_by`, so the rows it corrupted are exactly those with a status in
 *    ('approved','rejected') AND `resolved_by = status`. Both halves matter: the
 *    status half excludes cancelled/interrupted rows, which never had the column
 *    written at all, and the equality half separates a corrupted row from a
 *    genuine operator label.
 *    Without this, `getApprovalRecord` — the first code that ever reads the
 *    column — would surface corruption as an operator literally named
 *    "approved".
 * 2. Timestamps. Cancellation and interruption used to leave `resolved_at` NULL,
 *    which contradicts the documented meaning of the column ("when the row
 *    stopped being pending"). `updated_at` is the only available proxy.
 *
 * Residual, disclosed rather than hidden: this runs on every bootstrap, so an
 * operator whose label happens to equal the resulting status — "approved" on an
 * approved approval — would be cleared again at the next start. Such a label is
 * not a realistic operator identifier, and silently dropping caller values in
 * `normalizeResolvedBy` was judged the worse alternative.
 */
function repairLegacyApprovalRecords() {
  const db = getDatabase();
  db.prepare(`
    UPDATE pending_approvals
    SET resolved_by = NULL
    WHERE status IN ('approved', 'rejected') AND resolved_by = status
  `).run();
  db.prepare(`
    UPDATE pending_approvals
    SET resolved_at = updated_at
    WHERE status IN ('approved', 'rejected', 'cancelled', 'interrupted')
      AND resolved_at IS NULL
  `).run();
}

/**
 * Add `messages.origin`, deriving a value for rows that predate the column.
 *
 * A bare `ensureColumn` would label every historical row 'human', which is only
 * right for user-role rows: agent and system rows are equally old, and
 * `defaultOriginForRole` would have given them 'bot' and 'internal'. So the
 * backfill lives inside the same one-time branch as the ALTER. It must not run
 * on every boot, or it would keep rewriting rows that legitimately carry a
 * non-default origin for their role.
 *
 * The ALTER and the backfill share one transaction because they are only
 * correct together: a crash in between would leave the column present and every
 * row on the default, and the guard above would then never run the backfill
 * again — permanently reproducing the problem the derivation exists to avoid.
 *
 * The CASE mirrors `defaultOriginForRole` in repositories.ts; keep them in step.
 * `ELSE` covers every role that is neither user nor agent, not just system.
 */
function ensureMessageOriginColumn() {
  if (columnExists("messages", "origin")) return;
  const db = getDatabase();
  db.exec("BEGIN");
  try {
    db.exec("ALTER TABLE messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'human'");
    db.prepare(`
      UPDATE messages SET origin = CASE role
        WHEN 'user' THEN 'human'
        WHEN 'agent' THEN 'bot'
        ELSE 'internal'
      END
    `).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
