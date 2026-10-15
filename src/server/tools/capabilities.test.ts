import { describe, expect, it } from "vitest";
import {
  TOOL_CAPABILITIES,
  capabilitiesOf,
  workspaceModeFor,
  workspaceModeLabel,
  workspaceNoteFor
} from "@/server/tools/capabilities";
import { toolRegistry } from "@/server/tools/registry";
import { buildSystemPrompt } from "@/server/agent-runner";
import { buildConductorPlanPrompt } from "@/server/conductor-service";
import type { Agent, Conversation } from "@/shared/types";

/**
 * The prompt used to promise every agent an "isolated sandbox directory",
 * whatever tools it had — including bash, which runs on the host. These tests
 * hold the claim to the toolset.
 */

function agentWith(toolNames: string[]): Agent {
  return {
    id: "ag_test",
    name: "测试 Agent",
    description: "",
    avatar: "🤖",
    systemPrompt: "",
    toolNames,
    adapterName: "custom",
    isBuiltin: false,
    isConductor: false,
    capabilities: [],
    createdAt: 1,
    updatedAt: 1
  } as unknown as Agent;
}

function conversation(): Conversation {
  return { id: "conv_1", title: "t", mode: "single", agentIds: ["ag_test"], createdAt: 1, updatedAt: 1 } as unknown as Conversation;
}

describe("capability declarations", () => {
  it("covers every registered tool, with nothing orphaned", () => {
    const registered = toolRegistry.listNames().sort();
    expect(registered.length).toBeGreaterThan(10);
    expect(Object.keys(TOOL_CAPABILITIES).sort()).toEqual(registered);
  });

  it("has every tool declare the same capabilities as the table", () => {
    // Two places hold the declaration (the table, and the ToolDef that points
    // at it); this is what keeps them from drifting.
    for (const name of toolRegistry.listNames()) {
      expect(toolRegistry.get(name)?.capabilities).toEqual(TOOL_CAPABILITIES[name]);
    }
  });

  it("declares the reach of the tools that actually leave the workspace", () => {
    expect(TOOL_CAPABILITIES.bash).toContain("host-shell");
    expect(TOOL_CAPABILITIES.deploy_artifact).toContain("outside-workspace-write");
    expect(TOOL_CAPABILITIES.deploy_workspace).toContain("outside-workspace-write");
    expect(TOOL_CAPABILITIES.fs_write).toContain("workspace-write");
    expect(TOOL_CAPABILITIES.ask_user).toContain("user-interaction");
  });

  it("does not claim host access for the path-guarded family", () => {
    expect(capabilitiesOf(["fs_read", "fs_write", "fs_patch"]).has("host-shell")).toBe(false);
    expect(workspaceModeFor(["fs_read", "fs_write"])).toBe("confined");
  });
});

describe("the workspace claim follows the tools", () => {
  it("marks a bash-holding agent as host access, and says it is not a sandbox", () => {
    expect(workspaceModeLabel(["bash", "fs_write"])).toBe("host-access");
    const note = workspaceNoteFor(["bash", "fs_write"]).join("\n");
    expect(note).toContain("NOT sandboxed");
    expect(note).toContain("path-guarded");
  });

  it("keeps the confined claim for a toolset that cannot leave", () => {
    expect(workspaceModeLabel(["fs_read", "fs_write"])).toBe("workspace-confined");
    const note = workspaceNoteFor(["fs_read", "fs_write"]).join("\n");
    expect(note).toContain("path-guarded");
    expect(note).not.toContain("NOT sandboxed");
  });

  it("names the publish directory when a deploy tool is present", () => {
    expect(workspaceNoteFor(["deploy_artifact"]).join("\n")).toContain("OUTSIDE this directory");
  });

  it("tells the truth in the agent's system prompt", () => {
    const withBash = buildSystemPrompt(agentWith(["bash", "fs_write"]), conversation(), "/tmp/ws");
    expect(withBash).toContain("<mode>host-access</mode>");
    expect(withBash).toContain("NOT sandboxed");
    // The old blanket promise must be gone for this agent.
    expect(withBash).not.toContain("isolated sandbox directory");

    const confined = buildSystemPrompt(agentWith(["fs_read", "fs_write"]), conversation(), "/tmp/ws");
    expect(confined).toContain("<mode>workspace-confined</mode>");
    expect(confined).toContain("path-guarded");
    expect(confined).not.toContain("NOT sandboxed");
  });

  it("tells the truth in the conductor's planning prompt", () => {
    const prompt = buildConductorPlanPrompt(agentWith(["plan_tasks"]), [], "/tmp/ws");
    expect(prompt).toContain("<mode>workspace-confined</mode>");
    expect(prompt).not.toContain("isolated sandbox directory");
  });

  it("does not promise isolation to a bash-holding conductor either", () => {
    // A conductor agent can be given bash like any other; the old text said
    // "isolated sandbox directory" for every toolset.
    const withBash = buildConductorPlanPrompt(agentWith(["plan_tasks", "bash"]), [], "/tmp/ws");
    expect(withBash).toContain("<mode>host-access</mode>");
    expect(withBash).not.toContain("isolated sandbox directory");
  });
});
