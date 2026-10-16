import { describe, expect, it } from "vitest";
import { ALL_TOOL_NAMES } from "@/shared/agent-constants";
import { assertPiAccessProfile, CONVERSATION_TOOL_NAMES } from "./access-profile";

describe("conversation-only Pi access profile", () => {
  it("admits only the closed set of data/consultation tools", () => {
    expect(() => assertPiAccessProfile("conversation", CONVERSATION_TOOL_NAMES)).not.toThrow();
    expect(() => assertPiAccessProfile("conversation", [])).not.toThrow();
  });
  it.each([...ALL_TOOL_NAMES, "plan_tasks", "report_task_result", "list_team_members", "unknown-tool"].filter(name => !CONVERSATION_TOOL_NAMES.includes(name)))("rejects %s before starting a child or bypassing its lease", name => {
    expect(() => assertPiAccessProfile("conversation", [name])).toThrow("Conversation-only invocation cannot access");
  });
  it("does not silently alter normal workspace permissions", () => {
    expect(() => assertPiAccessProfile(undefined, ["fs_write", "bash"])).not.toThrow();
  });
});
