import { getAgent, getConversation, listAgents } from "@/server/repositories";
import { provisionedPlatformToolNames } from "@/server/pi/tool-surface";
import { TOOL_CAPABILITIES } from "./capabilities";
import type { ToolDef } from "./types";

export const listTeamMembersTool: ToolDef = {
  name: "list_team_members",
  description: "Query the current conversation's Agent roster before planning. Use exact member IDs; retired engines must be migrated before delegation. No credentials or system prompts are returned.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  capabilities: TOOL_CAPABILITIES.list_team_members,
  async handler(_args, ctx) {
    const conversation = getConversation(ctx.conversationId);
    const caller = getAgent(ctx.agentId);
    if (!conversation || !caller?.isConductor || !conversation.agentIds.includes(caller.id)) return { ok: false, error: "Only this conversation's Conductor may query its execution roster.", category: "security_policy" };
    // Issue #79: every Agent is provisioned with the whole Pi toolset, so the
    // roster reports that, not the stored grants (which no longer restrict or
    // authorize anything). A planner told "this member has no bash" would skip a
    // member that can in fact do the work.
    const tools = provisionedPlatformToolNames();
    return { ok: true, value: { members: listAgents().filter(agent => conversation.agentIds.includes(agent.id)).map(agent => ({
      id: agent.id, name: agent.name, description: agent.description, capabilities: agent.capabilities,
      toolNames: tools, isConductor: agent.isConductor, executionEngine: agent.adapterName,
      retired: agent.adapterName !== "pi", modelProvider: agent.modelProvider, modelId: agent.modelId,
    })) } };
  },
};
