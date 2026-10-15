import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "@/db/client";
import { createAgent, updateAgent } from "@/server/agent-service";
import { createConversation } from "@/server/conversation-service";
import { createMessage, createRun, getWorkspaceForConversation } from "@/server/repositories";
import { newRunId, newMessageId } from "@/shared/ids";
import { capturePiConfiguration, preparePiInvocation, snapshotPiProvider } from "./config";
import type { PiInvocationInput } from "./types";

afterEach(() => { vi.unstubAllEnvs(); });
function fixture(): PiInvocationInput {
  const agent = createAgent({ name: "Configuration fixture", adapterName: "pi", modelId: "deepseek-chat", toolNames: ["fs_read"] });
  const conversation = createConversation({ mode: "single", agentIds: [agent.id] });
  const workspace = getWorkspaceForConversation(conversation.id)!;
  const triggerMessage = createMessage({ id: newMessageId(), conversationId: conversation.id, role: "user", parts: [{ type: "text", content: "Fixture" }], status: "complete", now: Date.now() });
  return { agent, conversation, workspace, triggerMessage, runId: newRunId(), conversationId: conversation.id, workspacePath: workspace.rootPath, recentMessages: [], toolNames: agent.toolNames, systemPrompt: agent.systemPrompt, apiKey: null };
}

describe("immutable Pi execution configuration", () => {
  it("keeps a captured model credential across Conductor phases after settings change", () => {
    const input = fixture();
    getDatabase().prepare("UPDATE app_settings SET deepseek_api_key='old-fixture-key',updated_at=10 WHERE id='singleton'").run();
    const first = snapshotPiProvider(input.agent);
    getDatabase().prepare("UPDATE app_settings SET deepseek_api_key='new-fixture-key',updated_at=20 WHERE id='singleton'").run();
    const next = snapshotPiProvider(input.agent);
    expect(first.providerRevision).not.toBe(next.providerRevision);
    expect(capturePiConfiguration({ ...input, ...first }).apiKey).toBe("old-fixture-key");
    expect(capturePiConfiguration({ ...input, ...next }).apiKey).toBe("new-fixture-key");
  });
  it("stores only a credential reference and keeps global secrets out of the child environment", () => {
    vi.stubEnv("UNRELATED_HOST_SECRET", "never-forward-me");
    const input = capturePiConfiguration({ ...fixture(), apiKey: "private-fixture-key" });
    const execution = preparePiInvocation(input);
    const modelConfig = fs.readFileSync(path.join(execution.home, "models.json"), "utf8");
    expect(modelConfig).toContain("$AGENTMELD_PI_MODEL_KEY");
    expect(modelConfig).not.toContain("private-fixture-key");
    expect(JSON.parse(modelConfig).providers.agentmeld.models[0].maxTokens).toBe(65536);
    expect(JSON.parse(modelConfig).providers.agentmeld.compat.requiresReasoningContentOnAssistantMessages).toBe(true);
    expect(execution.env.AGENTMELD_PI_MODEL_KEY).toBe("private-fixture-key");
    expect(execution.env.UNRELATED_HOST_SECRET).toBeUndefined();
    expect(execution.env.PI_CODING_AGENT_DIR).toBe(execution.home);
    const binding = getDatabase().prepare("SELECT configuration_json FROM agent_execution_bindings WHERE version=?").get(execution.bindingVersion) as { configuration_json: string };
    expect(binding.configuration_json).not.toContain("private-fixture-key");
  });
  it("rejects execution edits during a run but permits presentation edits", () => {
    const input = fixture();
    createRun({ id: input.runId, conversationId: input.conversationId, agentId: input.agent.id, triggerMessageId: input.triggerMessage.id, status: "running", now: Date.now() });
    expect(() => updateAgent(input.agent.id, { modelId: "other-model" })).toThrow("active runs");
    expect(updateAgent(input.agent.id, { name: "Same identity", avatar: "AB" })?.id).toBe(input.agent.id);
  });
  it("refuses the old control-process command kernel instead of silently retaining a fallback", () => {
    const value = fixture();
    value.toolNames.push("job_start");
    expect(() => capturePiConfiguration(value)).toThrow("Legacy background tools");
  });
});
