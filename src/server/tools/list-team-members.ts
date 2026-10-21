import { getAgent, getConversation, listAgents } from "@/server/repositories";
import { provisionedPlatformToolNames } from "@/server/pi/tool-surface";
import { isRetiredAdapter, type HarnessAvailability } from "@/shared/harness-catalog";
import { TOOL_CAPABILITIES } from "./capabilities";
import type { ToolDef } from "./types";

export const listTeamMembersTool: ToolDef = {
  name: "list_team_members",
  description: "Query the current conversation's Agent roster before consultation or planning. Use exact member IDs; each member reports its execution engine and whether that engine is available here. A retired engine must be migrated before delegation, and an engine the platform reports as unavailable cannot run. No credentials or system prompts are returned.",
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
    // Imported lazily: the availability module reads the driver registry, and the
    // tool registry is itself inside the Pi driver's import graph. A static import
    // would re-enter `registry.ts` while it is still registering Pi.
    const { getHarnessAvailability, listHarnessAvailability } = await import("@/server/harness/availability");
    // One runtime probe for the whole roster; a name outside the catalog is still
    // answered honestly instead of being dropped.
    const availability = new Map<string, HarnessAvailability>(
      listHarnessAvailability().map((entry) => [entry.id, entry]),
    );
    const stateOf = (name: string) => (availability.get(name) ?? getHarnessAvailability(name)).state;
    return { ok: true, value: { members: listAgents().filter(agent => conversation.agentIds.includes(agent.id)).map(agent => {
      const engineState = stateOf(agent.adapterName);
      return {
        id: agent.id, name: agent.name, description: agent.description, capabilities: agent.capabilities,
        toolNames: tools, isConductor: agent.isConductor, executionEngine: agent.adapterName,
        // The catalog state is the honest answer to "can this engine run here?":
        // `available` needs a registered driver whose doctor passes; `opencode` is
        // not retired, just not shipped, so it is never mislabelled as legacy.
        executionEngineState: engineState,
        executionEngineAvailable: engineState === "available",
        retired: isRetiredAdapter(agent.adapterName), modelProvider: agent.modelProvider, modelId: agent.modelId,
      };
    }) } };
  },
};
