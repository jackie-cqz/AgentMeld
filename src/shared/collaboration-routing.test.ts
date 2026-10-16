import { describe, expect, it } from "vitest";
import { resolveMessageRecipients } from "./collaboration-routing";

const agents = [{ id: "conductor", isConductor: true }, { id: "frontend", isConductor: false }, { id: "designer", isConductor: false }];
const group = { mode: "group" as const, agentIds: agents.map(agent => agent.id) };
const reply = { role: "agent" as const, agentId: "frontend" };

describe("collaboration recipient precedence", () => {
  it("prefers explicit recipients over the replied-to author and deduplicates them", () => {
    expect(resolveMessageRecipients(group, agents, ["designer", "designer", "frontend"], reply)).toEqual(["designer", "frontend"]);
  });
  it("routes an ordinary reply to its Agent rather than the Conductor", () => {
    expect(resolveMessageRecipients(group, agents, [], reply)).toEqual(["frontend"]);
  });
  it("uses the Conductor for a new topic or a reply to the human", () => {
    expect(resolveMessageRecipients(group, agents)).toEqual(["conductor"]);
    expect(resolveMessageRecipients(group, agents, [], { role: "user", agentId: null })).toEqual(["conductor"]);
  });
  it("never silently ignores an invalid explicit recipient", () => {
    expect(() => resolveMessageRecipients(group, agents, ["unknown"])).toThrow("current conversation member");
    expect(() => resolveMessageRecipients({ ...group, agentIds: ["conductor", "frontend"] }, agents, ["designer"])).toThrow();
  });
  it("rejects a departed reply author unless the human explicitly chooses another recipient", () => {
    const smallerGroup = { ...group, agentIds: ["conductor", "designer"] };
    expect(() => resolveMessageRecipients(smallerGroup, agents, [], reply)).toThrow("no longer");
    expect(resolveMessageRecipients(smallerGroup, agents, ["designer"], reply)).toEqual(["designer"]);
  });
  it("uses the only member of a single conversation", () => {
    expect(resolveMessageRecipients({ mode: "single", agentIds: ["frontend"] }, agents)).toEqual(["frontend"]);
  });
  it("does not invent a default responder in a team without a Conductor", () => {
    expect(resolveMessageRecipients({ ...group, agentIds: ["frontend", "designer"] }, agents)).toEqual([]);
  });
});
