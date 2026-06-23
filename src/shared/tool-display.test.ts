import { describe, expect, it } from "vitest";
import { getToolDisplayName } from "@/shared/tool-display";

describe("getToolDisplayName", () => {
  it("returns Chinese labels for built-in tools", () => {
    expect(getToolDisplayName("ask_user")).toBe("询问用户");
    expect(getToolDisplayName("plan_tasks")).toBe("拆分任务");
    expect(getToolDisplayName("deploy_workspace")).toBe("部署工作区");
  });

  it("keeps unknown external tool names intact", () => {
    expect(getToolDisplayName("mcp__github__search")).toBe("mcp__github__search");
  });
});
