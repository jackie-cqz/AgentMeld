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
import { createPiBridge } from "@/server/pi/bridge";
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
    adapterName: "pi",
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

  it("points every tool at its OWN table entry, not an equal one", () => {
    // Identity, not value: fs_write and fs_patch declare the same array, so a
    // value comparison would not notice fs_write pointing at fs_patch's entry.
    for (const name of toolRegistry.listNames()) {
      expect(toolRegistry.get(name)?.capabilities).toBe(TOOL_CAPABILITIES[name]);
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
  it("describes background execution even without the bash tool", () => {
    expect(workspaceModeLabel(["job_start", "job_wait", "job_cancel"])).toBe("host-access");
    const note = workspaceNoteFor(["job_start", "job_wait", "job_cancel"]).join("\n");
    expect(note).toContain("job_start is NOT sandboxed");
    expect(note).toContain("owned by this exact Agent run");
  });

  it("describes public network disclosure and browser isolation limits", () => {
    expect(workspaceNoteFor(["web_search", "web_fetch"]).join("\n")).toContain("untrusted data");
    expect(workspaceNoteFor(["web_search"]).join("\n")).toContain("queries leave this machine");
    expect(workspaceModeLabel(["browser_check"])).toBe("host-access");
    expect(workspaceNoteFor(["browser_check"]).join("\n")).toContain("not an OS sandbox");
  });

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

  it("describes the conductor's PLAN toolset, not its configured one", () => {
    // The default conductor has bash in its agent record, but the plan stage
    // can only call CONDUCTOR_PLAN_TOOLS — no bash, no fs_write. Telling it
    // otherwise contradicts the stage instructions in the same prompt.
    const conductor = buildConductorPlanPrompt(agentWith(["plan_tasks", "bash", "fs_write"]), [], "/tmp/ws");
    expect(conductor).toContain("<mode>workspace-confined</mode>");
    expect(conductor).not.toContain("NOT sandboxed");
    expect(conductor).not.toContain("isolated sandbox directory");
  });

  it.each([["bash", "fs_write"], ["fs_read"]])("carries the actual workspace boundary through the Pi extension manifest: %j", async (...toolNames) => {
    const agent = agentWith(toolNames);
    const systemPrompt = buildSystemPrompt(agent, conversation(), "/tmp/ws");
    const bridge = await createPiBridge({ conversationId: "conv_1", runId: "fixture", agent, toolNames, systemPrompt, workspacePath: "/tmp/ws" } as never, new AbortController().signal, () => {});
    try {
      const response = await fetch(`${bridge.url}/manifest`, { headers: { Authorization: `Bearer ${bridge.token}` } });
      const manifest = await response.json();
      expect(manifest.systemPrompt).toContain(`<mode>${workspaceModeLabel(toolNames)}</mode>`);
      expect(manifest.systemPrompt).not.toContain("isolated sandbox directory");
      if (toolNames.includes("bash")) expect(manifest.systemPrompt).toContain("NOT sandboxed");
    } finally { await bridge.close(); }
  });
});
