import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { getSettings, updateSettings, resolveApiKey } from "@/server/settings-service";
import type { AppSettings } from "@/shared/types";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-settings-"));
  process.env.AGENT_CONFERENCE_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENT_CONFERENCE_DATA_DIR;
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("settings-service", () => {
  describe("getSettings", () => {
    it("returns default settings after bootstrap", () => {
      const settings = getSettings();
      expect(settings.id).toBe("singleton");
      expect(settings.companionMode).toBe("off");
      expect(settings.openaiApiKey).toBeNull();
      expect(settings.deploymentPublishEnabled).toBe(false);
    });
  });

  describe("updateSettings", () => {
    it("updates a provider key", () => {
      const updated = updateSettings({ openaiApiKey: "sk-test123" });
      expect(updated.openaiApiKey).toBe("sk-test123");

      const reloaded = getSettings();
      expect(reloaded.openaiApiKey).toBe("sk-test123");
    });

    it("normalizes empty string keys to null", () => {
      updateSettings({ openaiApiKey: "   " });
      const settings = getSettings();
      expect(settings.openaiApiKey).toBeNull();
    });

    it("preserves existing keys when updating a different field", () => {
      updateSettings({ openaiApiKey: "sk-abc" });
      updateSettings({ deepseekApiKey: "sk-xyz" });

      const settings = getSettings();
      expect(settings.openaiApiKey).toBe("sk-abc");
      expect(settings.deepseekApiKey).toBe("sk-xyz");
    });
  });

  describe("resolveApiKey", () => {
    it("returns agent key as highest priority", () => {
      updateSettings({ openaiApiKey: "sk-global" });
      process.env.OPENAI_API_KEY = "sk-env";

      const settings = getSettings();
      const key = resolveApiKey("openai", "sk-agent", settings);
      expect(key).toBe("sk-agent");
    });

    it("falls back to global settings key", () => {
      updateSettings({ deepseekApiKey: "sk-global-ds" });

      const settings = getSettings();
      const key = resolveApiKey("deepseek", null, settings);
      expect(key).toBe("sk-global-ds");
    });

    it("falls back to environment variable", () => {
      process.env.OPENAI_API_KEY = "sk-from-env";

      const settings = getSettings();
      const key = resolveApiKey("openai", null, settings);
      expect(key).toBe("sk-from-env");
    });

    it("returns null when no key is configured", () => {
      const settings = getSettings();
      const key = resolveApiKey("openai", null, settings);
      expect(key).toBeNull();
    });

    it("agent key overrides empty global key", () => {
      const settings = getSettings();
      const key = resolveApiKey("volcano-ark", "sk-ark-agent", settings);
      expect(key).toBe("sk-ark-agent");
    });
  });
});
