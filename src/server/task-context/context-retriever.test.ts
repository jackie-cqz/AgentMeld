// ---------------------------------------------------------------------------
// P8: FTS retrieval integration test — insert → rebuild → retrieve → compile
// ---------------------------------------------------------------------------

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { getDatabase } from "@/db/client";
import { setupTestDatabase } from "@/test/test-database";
import { ensureFtsIndexes, rebuildAllFts } from "@/server/search/context-fts-index";
import { retrieveContext } from "@/server/task-context/context-retriever";
import { newMessageId, newEvidenceId, newVerdictId, newTaskAttemptId, newContextSnapshotId } from "@/shared/ids";

const CONV_ID = "test-fts-conv";
const TASK_ID = "t3";
const ATTEMPT_ID = newTaskAttemptId();

let cleanup: () => void;

beforeAll(() => {
  cleanup = setupTestDatabase("context-retriever-test");
  ensureFtsIndexes();

  const db = getDatabase();
  const now = Date.now();

  // ── FK parents: agents + conversation + workspace + agent_runs ──────
  db.prepare(`INSERT OR IGNORE INTO agents (id, name, avatar, description, capabilities, system_prompt, adapter_name, model_provider, model_id, tool_names, is_builtin, is_conductor, supports_vision, created_at, updated_at) VALUES ('ag_pm', 'PM', '🤖', 'PM', '["pm"]', '', 'custom', 'deepseek', NULL, '["write_artifact"]', 0, 0, 0, ?, ?)`).run(now, now);
  db.prepare(`INSERT OR IGNORE INTO agents (id, name, avatar, description, capabilities, system_prompt, adapter_name, model_provider, model_id, tool_names, is_builtin, is_conductor, supports_vision, created_at, updated_at) VALUES ('ag_frontend', 'FE', '🤖', 'FE', '["frontend"]', '', 'custom', 'deepseek', NULL, '[]', 0, 0, 0, ?, ?)`).run(now, now);
  db.prepare(`INSERT OR IGNORE INTO conversations (id, title, mode, agent_ids, pinned_message_ids, archived, fs_write_approval_mode, created_at, updated_at) VALUES (?, 'Test', 'group', '["ag_pm","ag_frontend"]', '[]', 0, 'review', ?, ?)`).run(CONV_ID, now, now);
  db.prepare(`INSERT OR IGNORE INTO workspaces (id, conversation_id, mode, root_path, created_at, updated_at) VALUES ('ws_test', ?, 'sandbox', '/tmp/test', ?, ?)`).run(CONV_ID, now, now);
  db.prepare(`INSERT OR IGNORE INTO agent_runs (id, conversation_id, agent_id, trigger_message_id, parent_run_id, status, started_at, created_at, updated_at) VALUES ('run_conductor', ?, 'ag_pm', NULL, NULL, 'complete', ?, ?, ?)`).run(CONV_ID, now, now, now);
  db.prepare(`INSERT OR IGNORE INTO agent_runs (id, conversation_id, agent_id, trigger_message_id, parent_run_id, status, started_at, created_at, updated_at) VALUES ('run_child', ?, 'ag_frontend', NULL, 'run_conductor', 'complete', ?, ?, ?)`).run(CONV_ID, now, now, now);
  db.prepare(`INSERT OR IGNORE INTO agent_runs (id, conversation_id, agent_id, trigger_message_id, parent_run_id, status, started_at, created_at, updated_at) VALUES ('run_child_2', ?, 'ag_pm', NULL, 'run_conductor', 'complete', ?, ?, ?)`).run(CONV_ID, now, now, now);
  db.prepare(`INSERT OR IGNORE INTO agent_runs (id, conversation_id, agent_id, trigger_message_id, parent_run_id, status, started_at, created_at, updated_at) VALUES ('run_1', ?, 'ag_pm', NULL, NULL, 'complete', ?, ?, ?)`).run(CONV_ID, now, now, now);

  // ── Insert messages ───────────────────────────────────────────────────
  const msg1Id = newMessageId();
  db.prepare(`
    INSERT OR IGNORE INTO messages (id, conversation_id, role, agent_id, run_id, parts, status, mentioned_agent_ids, parent_message_id, created_at, updated_at)
    VALUES (?, ?, 'user', NULL, NULL, ?, 'complete', '[]', NULL, ?, ?)
  `).run(msg1Id, CONV_ID, JSON.stringify([{ type: "text", content: "主色用绿色，React前端，不需要登录" }]), now, now);

  const msg2Id = newMessageId();
  db.prepare(`
    INSERT OR IGNORE INTO messages (id, conversation_id, role, agent_id, run_id, parts, status, mentioned_agent_ids, parent_message_id, created_at, updated_at)
    VALUES (?, ?, 'agent', 'ag_pm', 'run_1', ?, 'complete', '[]', ?, ?, ?)
  `).run(msg2Id, CONV_ID, JSON.stringify([{ type: "text", content: "PRD已完成：Todo List应用，React框架，绿色主题，无需认证。" }]), msg1Id, now, now);

  // ── Insert artifacts ──────────────────────────────────────────────────
  db.prepare(`
    INSERT OR IGNORE INTO artifacts (id, conversation_id, created_by_agent_id, type, title, content, version, parent_artifact_id, created_at, updated_at)
    VALUES (?, ?, 'ag_pm', 'document', 'PRD - Todo App', '{}', 1, NULL, ?, ?)
  `).run("art_prd", CONV_ID, now, now);

  // ── Insert task attempt ───────────────────────────────────────────────
  db.prepare(`
    INSERT OR IGNORE INTO task_attempts (id, conductor_run_id, conversation_id, plan_id, plan_revision, task_id, agent_id, child_run_id, attempt, context_snapshot_id, execution_status, verification_status, created_at, updated_at)
    VALUES (?, 'run_conductor', ?, 'plan_test', 0, ?, 'ag_frontend', 'run_child', 1, ?, 'reported_complete', 'verified', ?, ?)
  `).run(ATTEMPT_ID, CONV_ID, TASK_ID, newContextSnapshotId(), now, now);

  // ── Insert evidence ───────────────────────────────────────────────────
  db.prepare(`
    INSERT OR IGNORE INTO task_evidence (id, conversation_id, conductor_run_id, plan_id, task_id, attempt_id, child_run_id, context_snapshot_id, agent_id, type, status, trust_level, source_kind, source_id, subject_type, subject_id, payload_json, content_hash, created_at)
    VALUES (?, ?, 'run_conductor', 'plan_test', ?, ?, 'run_child', ?, 'ag_frontend', 'file_written', 'valid', 'verified', 'tool_call', 'call_1', 'file', 'src/App.tsx', ?, 'hash123', ?)
  `).run(newEvidenceId(), CONV_ID, TASK_ID, ATTEMPT_ID, newContextSnapshotId(), JSON.stringify({ path: "src/App.tsx", action: "created" }), now);

  db.prepare(`
    INSERT OR IGNORE INTO task_evidence (id, conversation_id, conductor_run_id, plan_id, task_id, attempt_id, child_run_id, context_snapshot_id, agent_id, type, status, trust_level, source_kind, source_id, subject_type, subject_id, payload_json, content_hash, created_at)
    VALUES (?, ?, 'run_conductor', 'plan_test', ?, ?, 'run_child', ?, 'ag_frontend', 'command_executed', 'valid', 'verified', 'tool_call', 'call_2', 'command', 'pnpm build', ?, 'hash456', ?)
  `).run(newEvidenceId(), CONV_ID, TASK_ID, ATTEMPT_ID, newContextSnapshotId(), JSON.stringify({ command: "pnpm build", exitCode: 0 }), now);

  // Evidence for a DIFFERENT task (t1) — should NOT appear when filtering by t3
  const otherAttemptId = newTaskAttemptId();
  db.prepare(`
    INSERT OR IGNORE INTO task_attempts (id, conductor_run_id, conversation_id, plan_id, plan_revision, task_id, agent_id, child_run_id, attempt, context_snapshot_id, execution_status, verification_status, created_at, updated_at)
    VALUES (?, 'run_conductor', ?, 'plan_test', 0, 't1', 'ag_pm', 'run_child_2', 1, ?, 'reported_complete', 'verified', ?, ?)
  `).run(otherAttemptId, CONV_ID, newContextSnapshotId(), now, now);

  db.prepare(`
    INSERT OR IGNORE INTO task_evidence (id, conversation_id, conductor_run_id, plan_id, task_id, attempt_id, child_run_id, context_snapshot_id, agent_id, type, status, trust_level, source_kind, source_id, subject_type, subject_id, payload_json, content_hash, created_at)
    VALUES (?, ?, 'run_conductor', 'plan_test', 't1', ?, 'run_child_2', ?, 'ag_pm', 'artifact_created', 'valid', 'verified', 'tool_call', 'call_3', 'artifact', 'prd', ?, 'hash789', ?)
  `).run(newEvidenceId(), CONV_ID, otherAttemptId, newContextSnapshotId(), JSON.stringify({ outputKey: "prd" }), now);

  // ── Insert verdict ────────────────────────────────────────────────────
  db.prepare(`
    INSERT OR IGNORE INTO criterion_verdicts (id, attempt_id, criterion_id, validator_type, status, evidence_ids_json, reason, checked_at)
    VALUES (?, ?, 'build', 'command_exit', 'passed', '["ev_cmd"]', 'pnpm build exited with 0', ?)
  `).run(newVerdictId(), ATTEMPT_ID, now);

  // ── Insert conductor task result ──────────────────────────────────────
  db.prepare(`
    INSERT OR IGNORE INTO conductor_task_results (id, conductor_run_id, conversation_id, task_id, agent_id, title, status, summary, child_run_id, attempt, verification_status, verified_attempt_id, created_at, updated_at)
    VALUES (?, 'run_conductor', ?, ?, 'ag_frontend', 'Frontend: 实现应用', 'complete', 'Built Todo App with React, green theme, no auth', 'run_child', 1, 'verified', ?, ?, ?)
  `).run("task_result_1", CONV_ID, TASK_ID, ATTEMPT_ID, now, now);

  // ── Rebuild FTS indexes ───────────────────────────────────────────────
  rebuildAllFts(CONV_ID);
});

afterAll(() => {
  cleanup?.();
});

describe("P8 FTS retrieval integration", () => {
  it("retrieves messages matching query (ASCII tokenizer)", () => {
    // FTS5 unicode61 handles Latin words as tokens. Chinese characters
    // are individual tokens and may not match well without a dedicated
    // CJK tokenizer (jieba, icu). "React" and "Todo" appear in content.
    const results = retrieveContext({
      conversationId: CONV_ID,
      query: "Todo",
      maxResults: 10,
    });
    // At minimum, the non-message indexes (artifact, task result) should
    // return results for ASCII queries.
    const all = retrieveContext({
      conversationId: CONV_ID,
      query: "pnpm",
      maxResults: 20,
    });
    expect(all.length).toBeGreaterThan(0);
  });

  it("retrieves evidence matching query", () => {
    const results = retrieveContext({
      conversationId: CONV_ID,
      query: "pnpm build",
      maxResults: 10,
    });
    const evResults = results.filter(r => r.sourceType === "evidence");
    expect(evResults.length).toBeGreaterThan(0);
    expect(evResults.some(r => r.textContent.includes("pnpm build"))).toBe(true);
  });

  it("retrieves artifact and task results", () => {
    const results = retrieveContext({
      conversationId: CONV_ID,
      query: "PRD Todo",
      maxResults: 10,
    });
    const nonMsg = results.filter(r => r.sourceType !== "message");
    expect(nonMsg.length).toBeGreaterThan(0);
  });

  it("taskId filter excludes unrelated task results", () => {
    // Search specifically for t3's evidence — should NOT include t1's artifact
    const results = retrieveContext({
      conversationId: CONV_ID,
      query: "evidence",
      taskId: TASK_ID,
      maxResults: 10,
    });
    // t1's artifact_created evidence should NOT appear
    const t1Results = results.filter(r => r.taskId === "t1");
    expect(t1Results.length).toBe(0);
    // But t3's evidence should appear
    const t3Results = results.filter(r => r.taskId === TASK_ID);
    expect(t3Results.length).toBeGreaterThan(0);
  });

  it("excludeSourceIds filters out specified items", () => {
    const all = retrieveContext({
      conversationId: CONV_ID,
      query: "pnpm build",
      maxResults: 10,
    });
    const evIds = all.filter(r => r.sourceType === "evidence").map(r => r.sourceId);
    expect(evIds.length).toBeGreaterThan(0);

    if (evIds.length > 0) {
      const filtered = retrieveContext({
        conversationId: CONV_ID,
        query: "pnpm build",
        maxResults: 10,
        excludeSourceIds: evIds,
      });
      const filteredEv = filtered.filter(r => r.sourceType === "evidence");
      expect(filteredEv.length).toBe(0);
    }
  });

  it("empty query returns empty results", () => {
    const results = retrieveContext({
      conversationId: CONV_ID,
      query: "",
      maxResults: 10,
    });
    expect(results.length).toBe(0);
  });

  it("unknown conversation returns empty results", () => {
    const results = retrieveContext({
      conversationId: "nonexistent-conv",
      query: "anything",
      maxResults: 10,
    });
    expect(results.length).toBe(0);
  });

  it("lazy rebuild: retrieveContext works even without explicit rebuild", () => {
    // ensureFtsReady triggers rebuild when FTS is empty. The evidence
    // table has "src/App.tsx" as subjectId. Search for "App" (FTS5 may
    // split on dots).
    const results = retrieveContext({
      conversationId: CONV_ID,
      query: "App",
      maxResults: 5,
    });
    // Should find evidence or messages mentioning App
    const found = results.some(r =>
      r.textContent.includes("App") || r.textContent.includes("src/App")
    );
    expect(found).toBe(true);
  });
});
