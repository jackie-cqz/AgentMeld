import { getAgent, getConversation, listAgents } from "@/server/repositories";
import { provisionedPlatformToolNames } from "@/server/pi/tool-surface";
import { isRetiredAdapter } from "@/shared/harness-catalog";
import { TOOL_CAPABILITIES } from "./capabilities";
import type { ToolDef } from "./types";

export const listTeamMembersTool: ToolDef = {
  name: "list_team_members",
  description: "Query the current conversation's Agent roster before consultation or planning. Use exact member IDs; a retired engine must be migrated before delegation, and an engine the platform reports as unavailable cannot run. No credentials or system prompts are returned.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  capabilities: TOOL_CAPABILITIES.list_team_members,
  async handler(_args, ctx) {
    const conversation = getConversation(ctx.conversationId);
    if (!conversation) return { ok: false, error: "This conversation no longer exists, so its execution roster cannot be queried.", category: "security_policy" };
    const caller = getAgent(ctx.agentId);
    if (!caller || !conversation.agentIds.includes(caller.id)) {
      return { ok: false, error: "Only a current member of this conversation may query its roster.", category: "security_policy" };
    }
    // Issue #79: every Agent is provisioned with the whole Pi toolset, so the
    // roster reports that, not the stored grants (which no longer restrict or
    // authorize anything). A planner told "this member has no bash" would skip a
    // member that can in fact do the work.
    const tools = provisionedPlatformToolNames();
    return { ok: true, value: { members: listAgents().filter(agent => conversation.agentIds.includes(agent.id)).map(agent => ({
      id: agent.id, name: agent.name, description: agent.description, capabilities: agent.capabilities,
      toolNames: tools, isConductor: agent.isConductor, executionEngine: agent.adapterName,
      // `opencode` is not retired: it is a current choice whose driver this
      // build does not ship, so it must not be mislabelled as a legacy name.
      retired: isRetiredAdapter(agent.adapterName), modelProvider: agent.modelProvider, modelId: agent.modelId,
    })) } };
  },
};
