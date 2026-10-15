import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests } from "@/db/client";
import { createAgent, getAgentById, updateAgent } from "@/server/agent-service";
import { AGENT_AVATAR_AUTO, AGENT_AVATAR_PRESETS } from "@/shared/agent-avatar-presets";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-avatar-test-"));
  process.env.AGENTMELD_DATA_DIR = directory;
  resetBootstrapForTests(); resetDatabaseForTests(); ensureDatabase();
});
afterEach(() => {
  resetBootstrapForTests(); resetDatabaseForTests(); delete process.env.AGENTMELD_DATA_DIR;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("Agent avatar persistence", () => {
  it("round-trips every preset without a schema migration or model/tool changes", () => {
    for (const preset of AGENT_AVATAR_PRESETS) {
      const agent = createAgent({ name: preset.label, avatar: preset.id, adapterName: "custom", modelProvider: "deepseek", modelId: "fixture-model", toolNames: ["fs_read"] });
      expect(getAgentById(agent.id)?.avatar).toBe(preset.id);
      const updated = updateAgent(agent.id, { avatar: AGENT_AVATAR_AUTO });
      expect(updated?.avatar).toBe(AGENT_AVATAR_AUTO);
      expect(updated?.modelId).toBe("fixture-model");
      expect(updated?.toolNames).toEqual(["fs_read"]);
    }
  });
  it("keeps legacy avatar values on unrelated updates", () => {
    const agent = createAgent({ name: "Legacy", avatar: "AB", adapterName: "custom", modelId: "fixture-model" });
    expect(updateAgent(agent.id, { description: "New description" })?.avatar).toBe("AB");
  });
});
