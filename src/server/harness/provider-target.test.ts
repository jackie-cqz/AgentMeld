import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { createAgent, updateAgent } from "@/server/agent-service";
import { updateSettings } from "@/server/settings-service";
import { resolveHarnessProvider } from "./provider-target";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-provider-target-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("the neutral provider target", () => {
  it("carries the Agent's model-shaping choices next to the resolved provider", () => {
    updateSettings({ deepseekApiKey: "fixture-key" });
    const agent = createAgent({
      name: "Target fixture", adapterName: "pi", modelProvider: "deepseek",
      modelId: "deepseek-v4-flash", contextWindow: 200_000, reasoningEffort: "low",
      supportsVision: false, toolNames: [],
    });

    expect(resolveHarnessProvider(agent)).toMatchObject({
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      credential: "fixture-key",
      reasoningEffort: "low",
      vision: false,
      contextWindow: 200_000,
    });
  });

  it("leaves unset choices empty instead of inventing engine defaults", () => {
    const agent = createAgent({ name: "Defaults", adapterName: "opencode", modelId: "fixture", toolNames: [] });

    // Null window/effort mean "engine default"; vision keeps the historical
    // create default. No resolved window is guessed here — the driver owns that.
    expect(resolveHarnessProvider(agent)).toMatchObject({
      reasoningEffort: null,
      contextWindow: null,
      vision: true,
    });

    const edited = updateAgent(agent.id, { contextWindow: 8_000, reasoningEffort: "high", supportsVision: false })!;
    expect(resolveHarnessProvider(edited)).toMatchObject({
      reasoningEffort: "high",
      contextWindow: 8_000,
      vision: false,
    });
  });
});
