import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests, getDatabase } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import {
  createAgent,
  deleteAgent,
  getAllAgents,
  getAgentById,
  updateAgent
} from "@/server/agent-service";
import { TOOL_PRESETS, ALL_TOOL_NAMES, DEFAULT_CUSTOM_PROMPT } from "@/shared/agent-constants";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-agents-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  eventBus.clearForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("agent-service", () => {
  describe("createAgent", () => {
    it("creates a custom agent with model", () => {
      const agent = createAgent({
        name: "Test Custom Agent",
        adapterName: "pi",
        modelProvider: "openai",
        modelId: "gpt-4.1-mini",
        toolNames: ["fs_read", "write_artifact"]
      });

      expect(agent.id).toMatch(/^ag_/);
      expect(agent.name).toBe("Test Custom Agent");
      expect(agent.adapterName).toBe("pi");
      expect(agent.modelProvider).toBe("openai");
      expect(agent.modelId).toBe("gpt-4.1-mini");
      expect(agent.toolNames).toEqual(["fs_read", "write_artifact"]);
      expect(agent.isBuiltin).toBe(false);
      expect(agent.isConductor).toBe(false);
    });

    it("uses default system prompt when not provided", () => {
      const agent = createAgent({
        name: "Default Prompt",
        adapterName: "pi",
        modelId: "deepseek-chat"
      });
      expect(agent.systemPrompt).toBe(DEFAULT_CUSTOM_PROMPT);
      expect(agent.modelProvider).toBe("deepseek");
      expect(agent.toolNames).toEqual(TOOL_PRESETS["all-purpose"].tools);
    });

    it("rejects custom agent without model ID", () => {
      expect(() =>
        createAgent({
          name: "Bad Agent",
          adapterName: "pi",
          modelId: ""
        })
      ).toThrow("Pi Agents must specify a model ID.");
    });

    it("rejects the retired Claude Code placeholder", () => {
      expect(() => createAgent({
        name: "Claude Agent",
        adapterName: "claude-code",
        toolNames: ["fs_read"] // should be overridden
      })).toThrow("Pi execution engine");
    });

    it("rejects the retired Codex placeholder", () => {
      expect(() => createAgent({
        name: "Codex Agent",
        adapterName: "codex",
        toolNames: ["write_artifact"]
      })).toThrow("Pi execution engine");
    });

    it("accepts a saved OpenCode Agent even though this build ships no driver", () => {
      // The row is the user's durable choice; run time fails honestly instead of
      // silently rewriting the choice to Pi here.
      const agent = createAgent({
        name: "OpenCode Agent",
        adapterName: "opencode",
        modelProvider: "deepseek",
        modelId: "deepseek-v4-flash"
      });

      expect(agent.adapterName).toBe("opencode");
      expect(getAgentById(agent.id)?.adapterName).toBe("opencode");
    });

    it("still names the engine honestly when an OpenCode Agent is missing its model", () => {
      expect(() => createAgent({
        name: "OpenCode Agent without model",
        adapterName: "opencode"
      })).toThrow("OpenCode Agents must specify a model ID.");
    });
  });

  describe("getAgentById / getAllAgents", () => {
    it("returns created agents", () => {
      const a1 = createAgent({ name: "A1", adapterName: "pi", modelId: "gpt-4" });
      createAgent({ name: "A2", adapterName: "pi", modelId: "gpt-4" });

      const all = getAllAgents();
      // Built-in + 2 new
      expect(all.length).toBeGreaterThanOrEqual(2);

      const found = getAgentById(a1.id);
      expect(found?.name).toBe("A1");

      expect(getAgentById("ag_nonexistent")).toBeNull();
    });
  });

  describe("updateAgent", () => {
    it("updates name and tools", () => {
      const agent = createAgent({
        name: "Original",
        adapterName: "pi",
        modelId: "gpt-4"
      });

      const updated = updateAgent(agent.id, {
        name: "Renamed",
        toolNames: ["bash", "fs_read"]
      });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("Renamed");
      expect(updated!.toolNames).toEqual(["bash", "fs_read"]);
    });

    it("allows editing model/prompt/tools on built-in agents", () => {
      const builtins = getAllAgents().filter((a) => a.isBuiltin);
      expect(builtins.length).toBeGreaterThan(0);

      const updated = updateAgent(builtins[0].id, {
        modelId: "gpt-4.1-mini",
        systemPrompt: "Updated builtin prompt."
      });
      expect(updated).not.toBeNull();
      expect(updated!.modelId).toBe("gpt-4.1-mini");
      expect(updated!.systemPrompt).toBe("Updated builtin prompt.");
    });

    it("saves an OpenCode row and keeps the selected engine", () => {
      const agent = createAgent({
        name: "Switchable",
        adapterName: "pi",
        modelId: "gpt-4"
      });

      const updated = updateAgent(agent.id, { adapterName: "opencode" });

      expect(updated).not.toBeNull();
      expect(updated!.adapterName).toBe("opencode");
      expect(getAgentById(agent.id)?.adapterName).toBe("opencode");
    });

    it("keeps the historical migration error for a stored retired row until it is migrated", () => {
      const agent = createAgent({ name: "Legacy row", adapterName: "pi", modelId: "gpt-4" });
      // Old rows predate the Pi-only refactor; write one exactly as it exists.
      getDatabase().prepare("UPDATE agents SET adapter_name = 'claude-code' WHERE id = ?").run(agent.id);

      expect(() => updateAgent(agent.id, { name: "Renamed legacy row" }))
        .toThrow("Choose Pi and configure a provider to migrate this retired Agent.");
      expect(getAgentById(agent.id)?.adapterName).toBe("claude-code");
    });

    it("returns null for non-existent agent", () => {
      const result = updateAgent("ag_nonexistent", { name: "Nope" });
      expect(result).toBeNull();
    });
  });

  describe("deleteAgent", () => {
    it("deletes a non-builtin agent", () => {
      const agent = createAgent({ name: "ToDelete", adapterName: "pi", modelId: "gpt-4" });
      expect(getAgentById(agent.id)).not.toBeNull();

      const result = deleteAgent(agent.id);
      expect(result).toBe(true);
      expect(getAgentById(agent.id)).toBeNull();
    });

    it("cannot delete built-in agents", () => {
      const builtins = getAllAgents().filter((a) => a.isBuiltin);
      expect(builtins.length).toBeGreaterThan(0);

      expect(() => deleteAgent(builtins[0].id)).toThrow("Built-in agents cannot be deleted.");
    });

    it("returns false for non-existent agent", () => {
      expect(deleteAgent("ag_nonexistent")).toBe(false);
    });
  });

  describe("tool presets", () => {
    it("defines the supported presets", () => {
      expect(TOOL_PRESETS["all-purpose"].tools.length).toBeGreaterThan(0);
      expect(TOOL_PRESETS["local-code"].tools.length).toBeGreaterThan(0);
      expect(TOOL_PRESETS.artifact.tools.length).toBeGreaterThan(0);
      expect(TOOL_PRESETS.review.tools.length).toBeGreaterThan(0);
      expect(TOOL_PRESETS.deployment.tools.length).toBeGreaterThan(0);
      expect(TOOL_PRESETS.research.tools.length).toBeGreaterThan(0);
    });

    it("all presets only reference valid tool names", () => {
      for (const [, preset] of Object.entries(TOOL_PRESETS)) {
        for (const tool of preset.tools) {
          expect(ALL_TOOL_NAMES).toContain(tool);
        }
      }
    });

    it("accepts unknown or retired tool names instead of breaking the editor", () => {
      // Issue #79: grants no longer authorize anything, so rejecting them here
      // would only stop an Agent whose stored record is stale from being edited.
      const agent = createAgent({
        name: "Stale Tools",
        adapterName: "pi",
        modelProvider: "deepseek",
        modelId: "deepseek-chat",
        toolNames: ["fs_read", "made_up_tool", "job_start"]
      });
      expect(agent.toolNames).toEqual(["fs_read", "made_up_tool", "job_start"]);
    });

    it("requires key and base URL for openai-compatible agents", () => {
      expect(() => createAgent({
        name: "Compatible",
        adapterName: "pi",
        modelProvider: "openai-compatible",
        modelId: "custom-model"
      })).toThrow("API key");
    });
  });
});
