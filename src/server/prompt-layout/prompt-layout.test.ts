// ---------------------------------------------------------------------------
// P0: Prompt Layout tests
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { buildPromptLayout } from "@/server/prompt-layout/prompt-layout-builder";
import { generateCacheKey } from "@/server/prompt-layout/prompt-cache-key";

const baseInput = {
  agentId: "ag_test",
  agentName: "Test Agent",
  agentSystemPrompt: "You are a helpful assistant.",
  agentCapabilities: ["code", "write"],
  toolNames: ["fs_write", "bash", "read_artifact"],
  roleContractVersion: "role-contracts-v1",
  platformPromptVersion: "agentmeld-p0-v1",
  stableSections: [],
  userMessage: "Build a todo app",
  taskPrompt: "Implement the todo app",
  taskContextXml: "<task_context>...</task_context>",
  failureContextXml: "",
};

describe("buildPromptLayout", () => {
  it("produces a non-empty stable prefix", () => {
    const layout = buildPromptLayout(baseInput);
    expect(layout.stablePrefix.length).toBeGreaterThan(0);
    expect(layout.stablePrefix).toContain("ag_test");
  });

  it("produces a non-empty dynamic suffix with task context", () => {
    const layout = buildPromptLayout(baseInput);
    expect(layout.dynamicSuffix.length).toBeGreaterThan(0);
    expect(layout.dynamicSuffix).toContain("<task_context>");
  });

  it("stable prefix does not change when user message changes", () => {
    const layout1 = buildPromptLayout(baseInput);
    const layout2 = buildPromptLayout({ ...baseInput, userMessage: "Completely different request" });
    expect(layout1.stablePrefix).toBe(layout2.stablePrefix);
  });

  it("dynamic suffix changes when user message changes", () => {
    const layout1 = buildPromptLayout(baseInput);
    const layout2 = buildPromptLayout({ ...baseInput, userMessage: "Different" });
    expect(layout1.dynamicSuffix).not.toBe(layout2.dynamicSuffix);
  });

  it("stable prefix does not contain task context", () => {
    const layout = buildPromptLayout(baseInput);
    expect(layout.stablePrefix).not.toContain("<task_context>");
    expect(layout.stablePrefix).not.toContain("Build a todo app");
  });

  it("dynamic suffix contains task context", () => {
    const layout = buildPromptLayout(baseInput);
    expect(layout.dynamicSuffix).toContain("<task_context>");
    expect(layout.dynamicSuffix).toContain("Build a todo app");
  });

  it("cacheKey changes when agent systemPrompt changes", () => {
    const key1 = generateCacheKey({ agentId: "ag", agentSystemPrompt: "A", toolNames: ["a"], platformPromptVersion: "v1", roleContractVersion: "v1" });
    const key2 = generateCacheKey({ agentId: "ag", agentSystemPrompt: "B", toolNames: ["a"], platformPromptVersion: "v1", roleContractVersion: "v1" });
    expect(key1).not.toBe(key2);
  });

  it("cacheKey changes when toolNames change", () => {
    const key1 = generateCacheKey({ agentId: "ag", agentSystemPrompt: "A", toolNames: ["a"], platformPromptVersion: "v1", roleContractVersion: "v1" });
    const key2 = generateCacheKey({ agentId: "ag", agentSystemPrompt: "A", toolNames: ["a", "b"], platformPromptVersion: "v1", roleContractVersion: "v1" });
    expect(key1).not.toBe(key2);
  });

  it("sections include both stable and dynamic", () => {
    const layout = buildPromptLayout(baseInput);
    const stable = layout.sections.filter((s) => s.placement === "stable_prefix");
    const dynamic = layout.sections.filter((s) => s.placement === "dynamic_suffix");
    expect(stable.length).toBeGreaterThan(0);
    expect(dynamic.length).toBeGreaterThan(0);
  });

  it("all stable sections have stable=true", () => {
    const layout = buildPromptLayout(baseInput);
    for (const s of layout.sections.filter((s) => s.placement === "stable_prefix")) {
      expect(s.stable).toBe(true);
    }
  });
});
