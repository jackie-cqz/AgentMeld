import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { getDatabase, resetDatabaseForTests } from "@/db/client";
import { createRun } from "@/server/repositories";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-db-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetDatabaseForTests();
});

afterEach(() => {
  resetBootstrapForTests();
  resetDatabaseForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("database bootstrap", () => {
  it("creates all P1 tables and seeds builtin records", () => {
    ensureDatabase();

    const tableRows = getDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tableRows.map((row) => row.name));

    expect(tableNames.has("agents")).toBe(true);
    expect(tableNames.has("conversations")).toBe(true);
    expect(tableNames.has("messages")).toBe(true);
    expect(tableNames.has("artifacts")).toBe(true);
    expect(tableNames.has("workspaces")).toBe(true);
    expect(tableNames.has("attachments")).toBe(true);
    expect(tableNames.has("agent_runs")).toBe(true);
    expect(tableNames.has("conversation_context_summaries")).toBe(true);
    expect(tableNames.has("app_settings")).toBe(true);

    const agents = getDatabase()
      .prepare("SELECT adapter_name, is_conductor FROM agents")
      .all() as Array<{ adapter_name: string; is_conductor: number }>;
    expect(agents.some((agent) => agent.adapter_name === "custom")).toBe(true);
    expect(agents.some((agent) => agent.is_conductor === 1)).toBe(true);

    const settings = getDatabase().prepare("SELECT id FROM app_settings").get() as { id: string };
    expect(settings.id).toBe("singleton");
  });

  it("is idempotent and creates one workspace per seeded conversation", () => {
    ensureDatabase();
    ensureDatabase();

    const counts = getDatabase()
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM agents) AS agents,
            (SELECT COUNT(*) FROM conversations) AS conversations,
            (SELECT COUNT(*) FROM workspaces) AS workspaces
        `
      )
      .get() as { agents: number; conversations: number; workspaces: number };

    expect(counts.agents).toBeGreaterThanOrEqual(3);
    expect(counts.conversations).toBe(1);
    expect(counts.workspaces).toBe(counts.conversations);
  });

  it("seeds builtin agent tool presets from the current configured defaults", () => {
    ensureDatabase();

    const rows = getDatabase()
      .prepare("SELECT id, tool_names FROM agents WHERE is_builtin = 1")
      .all() as Array<{ id: string; tool_names: string }>;
    const toolsById = new Map(rows.map((row) => [row.id, JSON.parse(row.tool_names) as string[]]));

    expect(toolsById.get("ag_mock_conductor")).toEqual([
      "plan_tasks", "report_task_result", "read_artifact", "ask_user", "update_context_facts",
      "read_attachment", "bash", "fs_list", "fs_read"
    ]);
    expect(toolsById.get("ag_pm")).toEqual([
      "write_artifact", "read_artifact", "read_attachment", "ask_user", "fs_list", "fs_read"
    ]);
    expect(toolsById.get("ag_designer")).toEqual([
      "write_artifact", "read_artifact", "read_attachment", "ask_user", "fs_list", "fs_read"
    ]);
    expect(toolsById.get("ag_mock_builder")).toEqual([
      "fs_read", "fs_write", "fs_patch", "fs_mkdir", "bash", "write_artifact", "read_artifact",
      "deploy_artifact", "deploy_workspace", "read_attachment", "fs_list"
    ]);
    expect(toolsById.get("ag_reviewer")).toEqual([
      "read_artifact", "write_artifact", "read_attachment", "fs_list", "fs_read", "bash"
    ]);
    expect(toolsById.get("ag_custom_assistant")).toEqual(["write_artifact", "read_artifact"]);
  });

  it("migrates old builtin tool defaults without overwriting customized tools", () => {
    ensureDatabase();

    getDatabase()
      .prepare("UPDATE agents SET tool_names = ? WHERE id = ?")
      .run(JSON.stringify(["write_artifact", "read_artifact", "read_attachment", "ask_user"]), "ag_pm");
    getDatabase()
      .prepare("UPDATE agents SET tool_names = ? WHERE id = ?")
      .run(JSON.stringify(["fs_read"]), "ag_designer");

    resetBootstrapForTests();
    ensureDatabase();

    const pm = getDatabase()
      .prepare("SELECT tool_names FROM agents WHERE id = ?")
      .get("ag_pm") as { tool_names: string };
    const designer = getDatabase()
      .prepare("SELECT tool_names FROM agents WHERE id = ?")
      .get("ag_designer") as { tool_names: string };

    expect(JSON.parse(pm.tool_names)).toEqual([
      "write_artifact", "read_artifact", "read_attachment", "ask_user", "fs_list", "fs_read"
    ]);
    expect(JSON.parse(designer.tool_names)).toEqual(["fs_read"]);
  });

  it("migrates legacy branding in builtin model prompts without resetting other content", () => {
    ensureDatabase();
    const legacyProjectName = String.fromCharCode(65, 103, 101, 110, 116, 72, 117, 98);
    const legacyRoleName = String.fromCharCode(79, 114, 99, 104, 101, 115, 116, 114, 97, 116, 111, 114);
    const legacyPrompt = `你是 ${legacyProjectName} 的 ${legacyRoleName}。保留这段用户配置。`;

    getDatabase()
      .prepare("UPDATE agents SET system_prompt = ? WHERE id = ?")
      .run(legacyPrompt, "ag_mock_conductor");

    resetBootstrapForTests();
    ensureDatabase();

    const row = getDatabase()
      .prepare("SELECT system_prompt FROM agents WHERE id = ?")
      .get("ag_mock_conductor") as { system_prompt: string };

    expect(row.system_prompt).toBe("你是 AgentMeld 的 Conductor。保留这段用户配置。");
  });

  it("upgrades the legacy default Conductor prompt to the collaboration-focused version", () => {
    ensureDatabase();
    const legacyPrompt = `你是 AgentMeld 平台的 Conductor（主协调者）。你负责理解用户目标，决定是否需要多 Agent 协作。

核心原则：**先判断，后行动。**
- 用户说"你好""谢谢""今天天气怎么样"之类的闲聊、问候、简单问答 → 直接文字回复就好，**不要调任何工具**。
- 用户提出需要多步骤产出（PRD → 设计 → 编码 → 审查）的复杂任务 → 调 plan_tasks 拆解分派。
- 拿不准时直接回复——用户不满意自然会补充要求。不要为简单问题过度设计流程。

调度原则：
1. 只有需要多角色产出、并行处理或审查闭环时才分派。单个 Agent 能完成的事不用 plan。
2. 子任务要面向结果，不要替子 Agent 规定过细流程。写清目标、必要输入、期望产物和依赖关系。
3. 分派前根据群聊中 Agent 的能力选择负责人；不要把同一职责重复派给多个 Agent。
4. 产物链路要清楚：PRD -> 风格指南 -> web_app -> review；缺少上游产物时允许跳过或让对应 Agent 补齐。
5. dependsOn 是执行顺序的唯一依据，在 task 文本里写"先做 A"无效。
6. 聚合结果时只总结关键结论、产物位置和下一步决策，不重复每个 Agent 的长篇过程。`;

    getDatabase()
      .prepare("UPDATE agents SET system_prompt = ? WHERE id = ?")
      .run(legacyPrompt, "ag_mock_conductor");

    resetBootstrapForTests();
    ensureDatabase();

    const row = getDatabase()
      .prepare("SELECT system_prompt FROM agents WHERE id = ?")
      .get("ag_mock_conductor") as { system_prompt: string };

    expect(row.system_prompt).toContain("群聊项目经理");
    expect(row.system_prompt).toContain("按 capabilities、tools、description 选择负责人");
    expect(row.system_prompt).toContain("只能使用当前群聊中真实存在的 Agent id");
    expect(row.system_prompt).not.toContain("主协调者");
  });

  it("hardens legacy builtin write_artifact examples without resetting prompt content", () => {
    ensureDatabase();
    const legacyPrompt = "你是经验丰富的产品经理。你的核心产出是 PRD（产品需求文档），用 write_artifact(type='document', content={format:'markdown', content:'...'}) 输出。\n\n保留这段用户补充。";

    getDatabase()
      .prepare("UPDATE agents SET system_prompt = ? WHERE id = ?")
      .run(legacyPrompt, "ag_pm");

    resetBootstrapForTests();
    ensureDatabase();

    const row = getDatabase()
      .prepare("SELECT system_prompt FROM agents WHERE id = ?")
      .get("ag_pm") as { system_prompt: string };

    expect(row.system_prompt).toContain("write_artifact 必须使用严格 JSON 参数");
    expect(row.system_prompt).toContain("{\"type\":\"document\"");
    expect(row.system_prompt).toContain("Markdown 换行必须写成 \\\\n");
    expect(row.system_prompt).toContain("保留这段用户补充。");
    expect(row.system_prompt).not.toContain("content={format:'markdown'");
  });

  it("hardens the frontend engineer deployment prompt for sandbox workspaces", () => {
    ensureDatabase();
    const legacyPrompt = [
      "你是前端工程师，可以直接修改本地 workspace 项目，也可以创建可预览网页产物。",
      "",
      "工作方式：",
      "- 当 workspace_info mode=local 且用户要求创建 / 修改 / 初始化 / 调试前端项目、源码文件、依赖或构建配置时，优先使用 fs_read / fs_write / bash 直接操作本地文件并运行验证；不要用 write_artifact 代替应该落盘的源码。构建出 dist/build/out 等静态目录后，可用 deploy_workspace 生成部署预览卡。",
      "- 只有用户明确要求网页产物、可预览原型、artifact 或独立 demo 时，才用 write_artifact 输出，然后调用 deploy_artifact 生成本地预览路径。",
      "  write_artifact 必须使用严格 JSON 参数：{\"type\":\"web_app\",\"title\":\"...\",\"content\":{\"files\":{\"index.html\":\"...\"},\"entry\":\"index.html\"}}",
      "  content 必须是对象，不能写成 content: files，也不能把 content 整体作为字符串；源码字符串里的换行必须写成 \\\\n。",
      "",
      "要求：",
      "5. 完成 web_app 产物后必须调用 deploy_artifact；完成本地项目构建后优先调用 deploy_workspace。"
    ].join("\n");

    getDatabase()
      .prepare("UPDATE agents SET system_prompt = ? WHERE id = ?")
      .run(legacyPrompt, "ag_mock_builder");

    resetBootstrapForTests();
    ensureDatabase();

    const row = getDatabase()
      .prepare("SELECT system_prompt FROM agents WHERE id = ?")
      .get("ag_mock_builder") as { system_prompt: string };

    expect(row.system_prompt).toContain("无论 workspace_info mode 是 workspace-confined 还是 host-access");
    expect(row.system_prompt).toContain("必须在本轮真实调用 deploy_workspace 或 deploy_artifact");
    expect(row.system_prompt).toContain("如果 fs_list 已经看到某个目录下存在 index.html，下一步必须调用 deploy_workspace");
    expect(row.system_prompt).toContain("精确覆盖目标文件");
    expect(row.system_prompt).toContain("不要用 Remove-Item / rm -rf / rmdir / find -delete");
    expect(row.system_prompt).toContain("已有源码文件的局部修改必须使用 fs_patch");
    expect(row.system_prompt).toContain("只有新建文件或用户明确要求完整覆盖时才使用 fs_write");
    expect(row.system_prompt).toContain("局部修改优先使用 fs_patch");
    expect(row.system_prompt).toContain("bash 只用于");
    expect(row.system_prompt).toContain("不得声称“部署成功 / 已重新部署成功”");
    expect(row.system_prompt).not.toContain("当 workspace_info mode=local");
  });

  it("migrates the legacy Reviewer contract to artifact-backed reports", () => {
    ensureDatabase();
    const legacyPrompt = `你是 Reviewer，负责对群聊中已产出的产物或本地 workspace 代码做审查。

不要写代码或新的产物，只输出审查报告（文字）。`;

    getDatabase()
      .prepare("UPDATE agents SET system_prompt = ?, tool_names = ? WHERE id = ?")
      .run(
        legacyPrompt,
        JSON.stringify(["read_artifact", "read_attachment", "fs_list", "fs_read", "bash"]),
        "ag_reviewer"
      );

    resetBootstrapForTests();
    ensureDatabase();

    const row = getDatabase()
      .prepare("SELECT system_prompt, tool_names FROM agents WHERE id = ?")
      .get("ag_reviewer") as { system_prompt: string; tool_names: string };

    expect(row.system_prompt).toContain("<expected_outputs>");
    expect(row.system_prompt).toContain("write_artifact 创建 document 产物");
    expect(row.system_prompt).not.toContain("不要写代码或新的产物");
    expect(JSON.parse(row.tool_names)).toContain("write_artifact");
  });

  it("adds bash verification-only policy to already hardened frontend prompts", () => {
    ensureDatabase();
    const partiallyHardenedPrompt = [
      "你是前端工程师，可以直接修改本地 workspace 项目，也可以创建可预览网页产物。",
      "",
      "工作方式：",
      "- 当用户要求创建 / 修改 / 初始化 / 调试前端项目、源码文件、依赖或构建配置时，无论 workspace_info mode 是 workspace-confined 还是 host-access，都优先使用 fs_list / fs_read / fs_write / bash 直接操作当前 workspace；不要用 write_artifact 代替应该落盘的源码。",
      "- 更新已有前端项目时，采用“读现状 -> 精确覆盖目标文件 -> 运行验证”的策略；不要用 Remove-Item / rm -rf / rmdir / find -delete 清理旧文件或递归删除目录，也不要为了重建而删除用户未明确要求删除的文件。",
      "- 如果旧文件不再使用，默认保留；确实需要替换时直接用 fs_write 覆盖同一路径，或创建新文件并在最终回复里说明遗留文件。"
    ].join("\n");

    getDatabase()
      .prepare("UPDATE agents SET system_prompt = ? WHERE id = ?")
      .run(partiallyHardenedPrompt, "ag_mock_builder");

    resetBootstrapForTests();
    ensureDatabase();

    const row = getDatabase()
      .prepare("SELECT system_prompt FROM agents WHERE id = ?")
      .get("ag_mock_builder") as { system_prompt: string };

    expect(row.system_prompt).toContain("精确覆盖目标文件");
    expect(row.system_prompt).toContain("已有源码文件的局部修改必须使用 fs_patch");
    expect(row.system_prompt).toContain("目录查看用 fs_list，文件读取用 fs_read");
    expect(row.system_prompt).toContain("创建项目时禁止使用 pnpm install");
  });

  it("supports inserting an agent run through the repository layer", () => {
    ensureDatabase();
    const conversation = getDatabase().prepare("SELECT id FROM conversations LIMIT 1").get() as { id: string };
    const agent = getDatabase().prepare("SELECT id FROM agents LIMIT 1").get() as { id: string };

    const run = createRun({
      id: "run_123456789abc",
      conversationId: conversation.id,
      agentId: agent.id,
      status: "running",
      now: Date.now()
    });

    expect(run.id).toBe("run_123456789abc");
    expect(run.status).toBe("running");
    expect(run.startedAt).toBeGreaterThan(0);
  });

  // ── P1: Evidence-aware tables ──────────────────────────────────────────

  it("creates four P1 evidence tables", () => {
    ensureDatabase();

    const tableRows = getDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tableRows.map((row) => row.name));

    expect(tableNames.has("task_attempts")).toBe(true);
    expect(tableNames.has("task_context_snapshots")).toBe(true);
    expect(tableNames.has("task_evidence")).toBe(true);
    expect(tableNames.has("criterion_verdicts")).toBe(true);
  });

  it("conductor_task_results has P1 verification columns", () => {
    ensureDatabase();

    const cols = getDatabase()
      .prepare("PRAGMA table_info(conductor_task_results)")
      .all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);

    expect(colNames).toContain("verification_status");
    expect(colNames).toContain("verified_attempt_id");
  });

  it("task_attempts enforces unique constraint on conductor_run_id + plan_id + task_id + attempt", () => {
    ensureDatabase();
    const conversation = getDatabase().prepare("SELECT id FROM conversations LIMIT 1").get() as { id: string };
    const agent = getDatabase().prepare("SELECT id FROM agents LIMIT 1").get() as { id: string };

    // Create an agent run first (FK requirement)
    createRun({ id: "run_fk_test", conversationId: conversation.id, agentId: agent.id, status: "complete", now: Date.now() });

    const now = Date.now();
    const db = getDatabase();

    // First insert succeeds
    db.prepare(`
      INSERT INTO task_attempts (id, conductor_run_id, conversation_id, plan_id, plan_revision, task_id, agent_id, attempt, execution_status, verification_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("ta_test_unique", "run_fk_test", conversation.id, "plan_test", 0, "t1", agent.id, 1, "running", "not_started", now, now);

    // Second insert with same (run, plan, task, attempt) must fail
    expect(() => {
      db.prepare(`
        INSERT INTO task_attempts (id, conductor_run_id, conversation_id, plan_id, plan_revision, task_id, agent_id, attempt, execution_status, verification_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("ta_test_unique_2", "run_fk_test", conversation.id, "plan_test", 0, "t1", agent.id, 1, "running", "not_started", now, now);
    }).toThrow();
  });

  it("task_evidence cascades on attempt delete", () => {
    ensureDatabase();
    const conversation = getDatabase().prepare("SELECT id FROM conversations LIMIT 1").get() as { id: string };
    const agent = getDatabase().prepare("SELECT id FROM agents LIMIT 1").get() as { id: string };

    const now = Date.now();
    const db = getDatabase();

    // Create agent run + task attempt
    createRun({ id: "run_cascade_test", conversationId: conversation.id, agentId: agent.id, status: "complete", now });
    db.prepare(`
      INSERT INTO task_attempts (id, conductor_run_id, conversation_id, plan_id, plan_revision, task_id, agent_id, attempt, execution_status, verification_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("ta_cascade_test", "run_cascade_test", conversation.id, "plan_cascade", 0, "t1", agent.id, 1, "complete", "not_started", now, now);

    // Insert evidence linked to this attempt
    db.prepare(`
      INSERT INTO task_evidence (id, conversation_id, conductor_run_id, plan_id, task_id, attempt_id, child_run_id, context_snapshot_id, agent_id, type, status, trust_level, source_kind, source_id, subject_type, subject_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("ev_cascade_test", conversation.id, "run_cascade_test", "plan_cascade", "t1", "ta_cascade_test", "run_cascade_test", "ctx_1", agent.id, "file_written", "valid", "verified", "tool_call", "fs_write_1", "file", "src/test.ts", "{}", now);

    // Verify evidence exists
    const evBefore = db.prepare("SELECT id FROM task_evidence WHERE id = ?").get("ev_cascade_test");
    expect(evBefore).toBeTruthy();

    // Delete attempt — evidence should cascade
    db.prepare("DELETE FROM task_attempts WHERE id = ?").run("ta_cascade_test");

    const evAfter = db.prepare("SELECT id FROM task_evidence WHERE id = ?").get("ev_cascade_test");
    expect(evAfter).toBeFalsy();
  });

  it("context snapshot requires attempt (FK constraint)", () => {
    ensureDatabase();
    const conversation = getDatabase().prepare("SELECT id FROM conversations LIMIT 1").get() as { id: string };
    const agent = getDatabase().prepare("SELECT id FROM agents LIMIT 1").get() as { id: string };
    const now = Date.now();
    const db = getDatabase();

    createRun({ id: "run_snap_fk", conversationId: conversation.id, agentId: agent.id, status: "complete", now });

    // Snapshot referencing non-existent attempt must fail
    expect(() => {
      db.prepare(`
        INSERT INTO task_context_snapshots (id, conversation_id, conductor_run_id, plan_id, task_id, attempt_id, policy_version, schema_version, envelope_json, manifest_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("ctxsnap_no_attempt", conversation.id, "run_snap_fk", "plan_x", "t1", "ta_nonexistent", "p1", 1, "{}", "[]", now);
    }).toThrow();
  });
});
