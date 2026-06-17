import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
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
  process.env.AGENT_CONFERENCE_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  eventBus.clearForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENT_CONFERENCE_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("agent-service", () => {
  describe("createAgent", () => {
    it("creates a custom agent with model", () => {
      const agent = createAgent({
        name: "Test Custom Agent",
        adapterName: "custom",
        modelProvider: "openai",
        modelId: "gpt-4.1-mini",
        toolNames: ["fs_read", "write_artifact"]
      });

      expect(agent.id).toMatch(/^ag_/);
      expect(agent.name).toBe("Test Custom Agent");
      expect(agent.adapterName).toBe("custom");
      expect(agent.modelProvider).toBe("openai");
      expect(agent.modelId).toBe("gpt-4.1-mini");
      expect(agent.toolNames).toEqual(["fs_read", "write_artifact"]);
      expect(agent.isBuiltin).toBe(false);
      expect(agent.isOrchestrator).toBe(false);
    });

    it("uses default system prompt when not provided", () => {
      const agent = createAgent({
        name: "Default Prompt",
        adapterName: "custom",
        modelId: "gpt-4.1-mini"
      });
      expect(agent.systemPrompt).toBe(DEFAULT_CUSTOM_PROMPT);
    });

    it("rejects custom agent without model ID", () => {
      expect(() =>
        createAgent({
          name: "Bad Agent",
          adapterName: "custom",
          modelId: ""
        })
      ).toThrow("Custom agents must specify a model ID.");
    });

    it("creates a Claude Code agent with empty toolNames", () => {
      const agent = createAgent({
        name: "Claude Agent",
        adapterName: "claude-code",
        toolNames: ["fs_read"] // should be overridden
      });

      expect(agent.adapterName).toBe("claude-code");
      expect(agent.toolNames).toEqual([]);
      expect(agent.modelProvider).toBe("anthropic");
    });

    it("creates a Codex agent with empty toolNames", () => {
      const agent = createAgent({
        name: "Codex Agent",
        adapterName: "codex",
        toolNames: ["write_artifact"]
      });

      expect(agent.toolNames).toEqual([]);
    });
  });

  describe("getAgentById / getAllAgents", () => {
    it("returns created agents", () => {
      const a1 = createAgent({ name: "A1", adapterName: "custom", modelId: "gpt-4" });
      const a2 = createAgent({ name: "A2", adapterName: "custom", modelId: "gpt-4" });

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
        adapterName: "custom",
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

    it("cannot modify built-in agents", () => {
      const builtins = getAllAgents().filter((a) => a.isBuiltin);
      expect(builtins.length).toBeGreaterThan(0);

      expect(() =>
        updateAgent(builtins[0].id, { name: "Hacked" })
      ).toThrow("Built-in agents cannot be modified.");
    });

    it("returns null for non-existent agent", () => {
      const result = updateAgent("ag_nonexistent", { name: "Nope" });
      expect(result).toBeNull();
    });
  });

  describe("deleteAgent", () => {
    it("deletes a non-builtin agent", () => {
      const agent = createAgent({ name: "ToDelete", adapterName: "custom", modelId: "gpt-4" });
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
    it("defines all four presets", () => {
      expect(TOOL_PRESETS["all-purpose"].tools.length).toBeGreaterThan(0);
      expect(TOOL_PRESETS["local-code"].tools.length).toBeGreaterThan(0);
      expect(TOOL_PRESETS.artifact.tools.length).toBeGreaterThan(0);
      expect(TOOL_PRESETS.review.tools.length).toBeGreaterThan(0);
    });

    it("all presets only reference valid tool names", () => {
      for (const [, preset] of Object.entries(TOOL_PRESETS)) {
        for (const tool of preset.tools) {
          expect(ALL_TOOL_NAMES).toContain(tool);
        }
      }
    });
  });
});
