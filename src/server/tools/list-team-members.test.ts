import { describe, expect, it } from "vitest";
import { createConversation } from "@/server/conversation-service";
import { listTeamMembersTool } from "./list-team-members";
import type { ToolContext } from "./types";

describe("Conductor member lookup", () => {
  it("returns only conversation members without execution credentials", async () => {
    const conversation = createConversation({ mode: "group", agentIds: ["ag_mock_conductor", "ag_pm"] });
    const context = { conversationId: conversation.id, agentId: "ag_mock_conductor" } as ToolContext;
    const result = await listTeamMembersTool.handler({}, context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { members: Array<Record<string, unknown>> };
      expect(value.members.map(member => member.id).sort()).toEqual([...conversation.agentIds].sort());
      expect(JSON.stringify(value)).not.toMatch(/apiKey|apiBaseUrl|systemPrompt/);
    }
    expect(await listTeamMembersTool.handler({}, { ...context, agentId: "ag_pm" })).toMatchObject({ ok: false, category: "security_policy" });
  });
});
