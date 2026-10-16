import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConversation } from "@/server/conversation-service";
import { getDatabase } from "@/db/client";
import { createArtifact, getWorkspaceForConversation, listArtifacts, listConversations } from "@/server/repositories";
import { gateRequest } from "@/server/api-gate";
import { hasPairedOwner } from "@/server/auth";

import { BenchmarkEnvironmentManager } from "./environment-manager";

let baseDir = "";
let manager: BenchmarkEnvironmentManager;

beforeAll(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-benchmark-env-"));
});

afterAll(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

afterEach(() => {
  manager?.deactivate();
});

describe("BenchmarkEnvironmentManager", () => {
  it("uses a fresh database and workspace for every trial", () => {
    manager = new BenchmarkEnvironmentManager();
    const first = manager.create("isolation-case", { baseDir, trialIndex: 1 });
    manager.activate(first);
    const conversation = createConversation({
      title: "Trial one",
      mode: "group",
      agentIds: ["ag_mock_conductor", "ag_pm"],
    });
    const firstWorkspace = getWorkspaceForConversation(conversation.id);
    createArtifact({
      id: "art_trial_one",
      conversationId: conversation.id,
      createdByAgentId: "ag_pm",
      type: "document",
      title: "Trial one artifact",
      content: { type: "document", content: "isolated" },
      version: 1,
      now: Date.now(),
    });
    getDatabase().prepare(`
      INSERT INTO conversation_fact_definitions (
        id, conversation_id, canonical_key, namespace, entity_type, property_name,
        value_type, update_policy, description, aliases_json,
        applicable_task_tags_json, applicable_agent_roles_json, status, origin,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "fact_def_trial_one",
      conversation.id,
      "ui.theme",
      "ui",
      "theme",
      "name",
      "string",
      "replace",
      "Trial-only theme",
      "[]",
      "[]",
      "[]",
      "active",
      "conversation",
      Date.now(),
      Date.now(),
    );
    expect(listConversations()).toHaveLength(2);
    expect(listArtifacts(conversation.id)).toHaveLength(1);
    manager.deactivate();

    const second = manager.create("isolation-case", { baseDir, trialIndex: 2 });
    manager.activate(second);

    expect(second.dataDir).not.toBe(first.dataDir);
    expect(listConversations()).toHaveLength(1);
    expect(listArtifacts(conversation.id)).toHaveLength(0);
    const factCount = getDatabase().prepare(
      "SELECT COUNT(*) AS count FROM conversation_fact_definitions WHERE id = ?",
    ).get("fact_def_trial_one") as { count: number };
    expect(factCount.count).toBe(0);
    expect(firstWorkspace?.rootPath.startsWith(first.dataDir)).toBe(true);
    expect(second.rootDir).not.toBe(first.rootDir);
  });

  it("creates report directories before a trial starts", () => {
    manager = new BenchmarkEnvironmentManager();
    const environment = manager.create("report-case", { baseDir });
    expect(fs.existsSync(environment.dataDir)).toBe(true);
    expect(fs.existsSync(environment.reportDir)).toBe(true);
  });

  it("pairs a sandbox owner so owner-gated deployment routes admit the benchmark", async () => {
    manager = new BenchmarkEnvironmentManager();
    manager.activate(manager.create("pairing-case", { baseDir }));

    const owner = manager.ownerSession();
    expect(owner).not.toBeNull();
    expect(hasPairedOwner()).toBe(true);

    // The same credential a real browser carries: the gate admits the owner.
    const previewUrl = "http://127.0.0.1/deployments/dep_fixture";
    const allowed = await gateRequest(new Request(previewUrl, { headers: { cookie: owner!.cookieHeader } }));
    expect(allowed.allowed).toBe(true);
    expect(allowed.principal.kind).toBe("owner-session");

    // Without it the route is still gated — this is not a bypass.
    const anonymous = await gateRequest(new Request(previewUrl));
    expect(anonymous.allowed).toBe(false);
    expect(anonymous.allowed === false ? anonymous.response.status : 0).toBe(401);
  });
});
