import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { getSettings, updateSettings, resolveApiKey, resolveApiKeyForAgent, resolveApiBaseUrl } from "@/server/settings-service";
import type { AppSettings } from "@/shared/types";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-settings-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENTMELD_DATA_DIR;
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

    it("returns null for openai-compatible even when global key exists", () => {
      updateSettings({ openaiApiKey: "sk-global" });
      const settings = getSettings();
      const key = resolveApiKey("openai-compatible", null, settings);
      expect(key).toBeNull(); // §6.1 Rule 3: openai-compatible 不查全局
    });
  });

  describe("resolveApiKeyForAgent", () => {
    it("returns per-agent key as highest priority", () => {
      updateSettings({ openaiApiKey: "sk-global" });
      const settings = getSettings();
      const key = resolveApiKeyForAgent(
        { adapterName: "custom", modelProvider: "openai", apiKey: "sk-per-agent" },
        settings
      );
      expect(key).toBe("sk-per-agent");
    });

    it("claude-code adapter reads anthropic global key", () => {
      updateSettings({ anthropicApiKey: "sk-ant-global" });
      const settings = getSettings();
      const key = resolveApiKeyForAgent(
        { adapterName: "claude-code", apiKey: null },
        settings
      );
      expect(key).toBe("sk-ant-global");
    });

    it("claude-code adapter falls back to ANTHROPIC_AUTH_TOKEN then ANTHROPIC_API_KEY env var", () => {
      const prevToken = process.env.ANTHROPIC_AUTH_TOKEN;
      const prevKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;

      process.env.ANTHROPIC_API_KEY = "sk-ant-env-test";
      const settings = getSettings();
      const key = resolveApiKeyForAgent(
        { adapterName: "claude-code", apiKey: null },
        settings
      );
      expect(key).toBe("sk-ant-env-test");

      // Restore
      delete process.env.ANTHROPIC_API_KEY;
      if (prevKey) process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevToken) process.env.ANTHROPIC_AUTH_TOKEN = prevToken;
    });

    it("codex adapter reads openai global key", () => {
      updateSettings({ openaiApiKey: "sk-oai-global" });
      const settings = getSettings();
      const key = resolveApiKeyForAgent(
        { adapterName: "codex", apiKey: null },
        settings
      );
      expect(key).toBe("sk-oai-global");
    });

    it("codex adapter falls back to CODEX_API_KEY env var", () => {
      const prev = process.env.CODEX_API_KEY;
      delete process.env.CODEX_API_KEY;

      process.env.CODEX_API_KEY = "sk-codex-env-test";
      const settings = getSettings();
      const key = resolveApiKeyForAgent(
        { adapterName: "codex", apiKey: null },
        settings
      );
      expect(key).toBe("sk-codex-env-test");

      delete process.env.CODEX_API_KEY;
      if (prev) process.env.CODEX_API_KEY = prev;
    });

    it("custom adapter uses modelProvider to pick global key", () => {
      updateSettings({ deepseekApiKey: "sk-ds-global" });
      const settings = getSettings();
      const key = resolveApiKeyForAgent(
        { adapterName: "custom", modelProvider: "deepseek", apiKey: null },
        settings
      );
      expect(key).toBe("sk-ds-global");
    });
  });

  describe("resolveApiBaseUrl", () => {
    it("returns per-agent base URL as priority", () => {
      const settings = getSettings();
      const url = resolveApiBaseUrl(
        { adapterName: "custom", apiBaseUrl: "https://my-gateway.com" },
        settings
      );
      expect(url).toBe("https://my-gateway.com");
    });

    it("claude-code adapter reads anthropic base URL from global settings", () => {
      updateSettings({ anthropicBaseUrl: "https://anyrouter.io" });
      const settings = getSettings();
      const url = resolveApiBaseUrl(
        { adapterName: "claude-code", apiBaseUrl: null },
        settings
      );
      expect(url).toBe("https://anyrouter.io");
    });

    it("returns null when no base URL configured", () => {
      const settings = getSettings();
      const url = resolveApiBaseUrl(
        { adapterName: "custom", apiBaseUrl: null },
        settings
      );
      expect(url).toBeNull();
    });
  });
});
