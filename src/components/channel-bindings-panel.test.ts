import { describe, expect, it } from "vitest";
import { deriveAgentBindingState, formatRemainingMs } from "@/components/channel-bindings-panel";
import type { ChannelBinding, ChannelBindingSession } from "@/shared/types";

function binding(agentId: string, appId = "cli_1"): ChannelBinding {
  return {
    id: "cb_1",
    agentId,
    channel: "feishu",
    appId,
    tenantBrand: "feishu",
    botOpenId: null,
    boundByOpenId: null,
    chatId: null,
    conversationId: null,
    createdAt: 1,
    updatedAt: 1
  };
}

function session(
  agentId: string,
  status: ChannelBindingSession["status"],
  overrides: Partial<ChannelBindingSession> = {}
): ChannelBindingSession {
  return { id: `cbs_${agentId}_${status}`, agentId, status, expiresAt: 1000, ...overrides };
}

describe("deriveAgentBindingState", () => {
  it("reports unbound when there is neither a binding nor a session", () => {
    expect(deriveAgentBindingState("ag_1", undefined, {})).toEqual({ kind: "unbound" });
  });

  it("reports bound when a stored binding exists", () => {
    const state = deriveAgentBindingState("ag_1", binding("ag_1"), {});
    expect(state.kind).toBe("bound");
    if (state.kind !== "bound") return;
    expect(state.binding.appId).toBe("cli_1");
  });

  it("prefers the binding over a leftover session", () => {
    // The server refuses a new attempt while a binding exists, so a session here
    // would be stale; showing "waiting to scan" would be wrong.
    const state = deriveAgentBindingState("ag_1", binding("ag_1"), {
      s1: session("ag_1", "awaiting_scan")
    });
    expect(state.kind).toBe("bound");
  });

  it("reports binding while an attempt is waiting for the scan", () => {
    const state = deriveAgentBindingState("ag_1", undefined, { s1: session("ag_1", "awaiting_scan") });
    expect(state.kind).toBe("binding");
  });

  it("reports failed for a failed attempt and surfaces its message", () => {
    const state = deriveAgentBindingState("ag_1", undefined, {
      s1: session("ag_1", "failed", { error: "access_denied: 用户拒绝了授权" })
    });
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") return;
    expect(state.session.error).toContain("access_denied");
  });

  it("does not confuse another agent's session for this agent's", () => {
    // Sessions are stored in one flat map, so this is the easy mistake.
    const state = deriveAgentBindingState("ag_1", undefined, {
      s1: session("ag_2", "awaiting_scan")
    });
    expect(state.kind).toBe("unbound");
  });

  it("does not treat a cancelled session as a live attempt", () => {
    const state = deriveAgentBindingState("ag_1", undefined, { s1: session("ag_1", "cancelled") });
    expect(state.kind).toBe("unbound");
  });

  it("does not treat a succeeded session without a binding as bound", () => {
    // Possible if the binding list has not been refreshed yet; "unbound" is the
    // honest answer until the stored binding actually arrives.
    const state = deriveAgentBindingState("ag_1", undefined, { s1: session("ag_1", "succeeded") });
    expect(state.kind).toBe("unbound");
  });

  it("prefers a waiting attempt over an earlier failure", () => {
    const state = deriveAgentBindingState("ag_1", undefined, {
      s1: session("ag_1", "failed"),
      s2: session("ag_1", "awaiting_scan")
    });
    expect(state.kind).toBe("binding");
  });
});

describe("formatRemainingMs", () => {
  it("formats minutes and zero-padded seconds", () => {
    expect(formatRemainingMs(9 * 60_000 + 5_000)).toBe("9:05");
    expect(formatRemainingMs(60_000)).toBe("1:00");
    expect(formatRemainingMs(3600_000)).toBe("60:00");
  });

  it("reports an expired or exhausted window rather than a negative time", () => {
    expect(formatRemainingMs(0)).toBe("已过期");
    expect(formatRemainingMs(-1)).toBe("已过期");
  });

  it("floors partial seconds instead of rounding up", () => {
    expect(formatRemainingMs(1_999)).toBe("0:01");
  });
});
