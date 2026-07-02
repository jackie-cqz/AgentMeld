import { describe, expect, it } from "vitest";
import { getAgentAvatarLabel, getAgentAvatarStyle } from "@/shared/agent-avatar";
import type { Agent } from "@/shared/types";

describe("getAgentAvatarStyle", () => {
  it("keeps conductors purple", () => {
    expect(styleFor({ name: "Anything", isConductor: true }).solid).toContain("violet");
  });

  it("assigns stable colors to built-in role families", () => {
    expect(styleFor({ name: "PM 小灰", capabilities: ["requirements", "PRD"] }).solid).toContain("blue");
    expect(styleFor({ name: "UI 设计师", capabilities: ["design", "UI"] }).solid).toContain("fuchsia");
    expect(styleFor({ name: "前端工程师", capabilities: ["react", "frontend"] }).solid).toContain("cyan");
    expect(styleFor({ name: "Reviewer", capabilities: ["code-review"] }).solid).toContain("amber");
  });

  it("uses the same fallback color for the same agent", () => {
    const first = styleFor({ id: "ag_stable", name: "Specialist", capabilities: [] });
    const second = styleFor({ id: "ag_stable", name: "Renamed specialist", capabilities: [] });
    expect(first).toEqual(second);
  });

  it("uses compact role labels in the conversation header", () => {
    expect(labelFor({ name: "Conductor", isConductor: true })).toBe("CO");
    expect(labelFor({ name: "PM 小灰", capabilities: ["product"] })).toBe("PM");
    expect(labelFor({ name: "UI 设计师", capabilities: ["design"] })).toBe("UI");
    expect(labelFor({ name: "前端工程师", capabilities: ["frontend"] })).toBe("FE");
  });
});

function styleFor(overrides: Partial<Agent>) {
  return getAgentAvatarStyle({
    id: overrides.id ?? "ag_test",
    name: overrides.name ?? "Agent",
    capabilities: overrides.capabilities ?? [],
    isConductor: overrides.isConductor ?? false
  });
}

function labelFor(overrides: Partial<Agent>) {
  return getAgentAvatarLabel({
    id: overrides.id ?? "ag_test",
    name: overrides.name ?? "Agent",
    capabilities: overrides.capabilities ?? [],
    isConductor: overrides.isConductor ?? false
  });
}
