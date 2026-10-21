import { describe, expect, it } from "vitest";
import { getDatabase } from "@/db/client";
import { createAgent } from "@/server/agent-service";
import { createConversation } from "@/server/conversation-service";
import { getWorkspaceForConversation } from "@/server/repositories";
import { getOpenCodeDoctor } from "@/server/harness/opencode-driver";
import { listTeamMembersTool } from "./list-team-members";

describe("shared conversation roster", () => {
  it("lets a non-Conductor with no historical tool grants discover its peers", async () => {
    const worker = createAgent({ name: "Roster worker", adapterName: "pi", modelId: "fixture", toolNames: [] });
    const peer = createAgent({ name: "Roster peer", adapterName: "pi", modelId: "fixture", toolNames: [] });
    createAgent({ name: "Unrelated member", adapterName: "pi", modelId: "fixture", toolNames: [] });
    const conversation = createConversation({ mode: "group", agentIds: [worker.id, peer.id] });
    const ctx = { conversationId: conversation.id, agentId: worker.id, runId: "roster-fixture",
      workspacePath: getWorkspaceForConversation(conversation.id)!.rootPath, abortSignal: new AbortController().signal };
    const result = await listTeamMembersTool.handler({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const members = (result.value as { members: Array<{ id: string; toolNames: string[] }> }).members;
    expect(members.map(member => member.id).sort()).toEqual([worker.id, peer.id].sort());
    for (const member of members) expect(member.toolNames).toEqual(expect.arrayContaining(["fs_write", "fs_patch", "bash", "consult_agent"]));
    expect(JSON.stringify(result.value)).not.toContain("systemPrompt");
    expect(JSON.stringify(result.value)).not.toContain("apiKey");
    expect(JSON.stringify(result.value)).not.toContain("apiBaseUrl");
    expect(await listTeamMembersTool.handler({}, { ...ctx, agentId: "ag_pm" })).toMatchObject({ ok: false, category: "security_policy" });
  });

  it("reports each member's engine availability, not just the engine name", async () => {
    const worker = createAgent({ name: "Roster worker", adapterName: "pi", modelId: "fixture", toolNames: [] });
    const peer = createAgent({ name: "Roster OpenCode peer", adapterName: "opencode", modelId: "fixture", toolNames: [] });
    const retired = createAgent({ name: "Legacy peer", adapterName: "pi", modelId: "fixture", toolNames: [] });
    // A retired row is historical state no editing path produces any more.
    getDatabase().prepare("UPDATE agents SET adapter_name='custom' WHERE id=?").run(retired.id);
    const conversation = createConversation({ mode: "group", agentIds: [worker.id, peer.id, retired.id] });
    const ctx = { conversationId: conversation.id, agentId: worker.id, runId: "roster-fixture",
      workspacePath: getWorkspaceForConversation(conversation.id)!.rootPath, abortSignal: new AbortController().signal };

    const result = await listTeamMembersTool.handler({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    type Member = {
      id: string;
      executionEngine: string;
      executionEngineState: string;
      executionEngineAvailable: boolean;
      retired: boolean;
    };
    const byId = new Map((result.value as { members: Member[] }).members.map(member => [member.id, member]));

    // The Pi outcome is the pre-change one, with the runtime state added.
    expect(byId.get(worker.id)).toMatchObject({
      executionEngine: "pi", executionEngineState: "available", executionEngineAvailable: true, retired: false,
    });
    // `opencode` is a current choice with a real driver, so its availability is
    // whatever this machine's doctor says — never a hardcoded label.
    const opencodeAvailable = getOpenCodeDoctor().available;
    expect(byId.get(peer.id)).toMatchObject({
      executionEngine: "opencode",
      executionEngineState: opencodeAvailable ? "available" : "not-installed",
      executionEngineAvailable: opencodeAvailable,
      retired: false,
    });
    expect(byId.get(retired.id)).toMatchObject({
      executionEngine: "custom", executionEngineState: "retired", executionEngineAvailable: false, retired: true,
    });
  });
});
