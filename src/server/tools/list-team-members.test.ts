import { describe, expect, it } from "vitest";
import { createAgent } from "@/server/agent-service";
import { createConversation } from "@/server/conversation-service";
import { getWorkspaceForConversation } from "@/server/repositories";
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
});
