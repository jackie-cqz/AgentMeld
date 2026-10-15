import { describe, expect, it } from "vitest";
import { getAgentAvatarRole, getAgentAvatarLabel } from "./agent-avatar";

const identify = (name: string, capabilities: string[] = []) => ({ id: "avatar_test", name, capabilities, isConductor: false });

describe("Agent avatar role icons", () => {
  it("prefers the named role over secondary skills", () => {
    expect(getAgentAvatarRole(identify("Reviewer", ["react", "PRD"]))).toBe("reviewer");
    expect(getAgentAvatarRole(identify("前端工程师", ["UI", "design"]))).toBe("frontend");
  });
  it("does not confuse build with UI or development with PM", () => {
    expect(getAgentAvatarRole(identify("Build Specialist", ["development"]))).toBe("custom");
  });
  it("recognizes short role names at word boundaries", () => {
    expect(getAgentAvatarRole(identify("PM 小灰"))).toBe("product");
    expect(getAgentAvatarRole(identify("UI 设计师"))).toBe("design");
    expect(getAgentAvatarRole(identify("QA"))).toBe("reviewer");
  });
  it("falls back to capabilities for a personal name", () => {
    expect(getAgentAvatarRole(identify("Atlas", ["frontend"]))).toBe("frontend");
  });
  it("keeps custom monograms and an empty-name fallback", () => {
    expect(getAgentAvatarLabel(identify("Atlas Helper"))).toBe("AH");
    expect(getAgentAvatarLabel(identify("星河"))).toBe("星河");
    expect(getAgentAvatarLabel(identify(""))).toBe("AG");
  });
});
