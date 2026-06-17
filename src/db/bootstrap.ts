import fs from "node:fs";
import path from "node:path";
import { BUILTIN_AGENTS } from "@/db/builtin-agents";
import { getDataDir, getDatabase } from "@/db/client";
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
      is_orchestrator INTEGER NOT NULL DEFAULT 0,
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
      error TEXT,
      usage TEXT,
      started_at INTEGER NOT NULL,
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
  seedBuiltinAgents();
  seedAppSettings();
  seedWelcomeConversation();
  bootstrapped = true;
}

export function resetBootstrapForTests() {
  bootstrapped = false;
}

function migrateLegacyTables() {
  ensureColumn("agents", "avatar", "TEXT NOT NULL DEFAULT '🤖'");
  ensureColumn("agents", "capabilities", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("agents", "api_key", "TEXT");
  ensureColumn("agents", "api_base_url", "TEXT");
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

function createIndexes() {
  getDatabase().exec(`
    CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at);
    CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_conv ON attachments(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_runs_parent ON agent_runs(parent_run_id);
    CREATE INDEX IF NOT EXISTS idx_context_summaries_conv_created
      ON conversation_context_summaries(conversation_id, created_at);
  `);
}

function seedBuiltinAgents() {
  const db = getDatabase();
  const now = Date.now();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO agents (
      id, name, avatar, description, capabilities, system_prompt, adapter_name,
      model_provider, model_id, api_key, api_base_url, tool_names, is_builtin,
      is_orchestrator, supports_vision, created_at, updated_at
    ) VALUES (
      @id, @name, @avatar, @description, @capabilities, @systemPrompt, @adapterName,
      @modelProvider, @modelId, @apiKey, @apiBaseUrl, @toolNames, @isBuiltin,
      @isOrchestrator, @supportsVision, @createdAt, @updatedAt
    )
  `);

  for (const agent of BUILTIN_AGENTS) {
    insert.run({
      ...agent,
      capabilities: JSON.stringify(agent.capabilities),
      toolNames: JSON.stringify(agent.toolNames),
      isBuiltin: agent.isBuiltin ? 1 : 0,
      isOrchestrator: agent.isOrchestrator ? 1 : 0,
      supportsVision: agent.supportsVision ? 1 : 0,
      createdAt: now,
      updatedAt: now
    });
  }
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
    "Agent-Conference MVP 群聊",
    "group",
    JSON.stringify(["ag_mock_orchestrator", "ag_mock_builder"]),
    "review",
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
  const columns = getDatabase().prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) return;
  getDatabase().exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}
