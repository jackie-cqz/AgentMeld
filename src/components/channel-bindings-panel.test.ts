import { describe, expect, it } from "vitest";
import {
  deriveAgentBindingState,
  describeLauncherWindow,
  formatRemainingMs,
  isSafeLauncherUrl,
  shouldRefreshBindings
} from "@/components/channel-bindings-panel";
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
    expect(state.appId).toBe("cli_1");
    expect(state.bindingId).toBe("cb_1");
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

  it("reports bound straight from a succeeded session, before the binding arrives", () => {
    // A success event names the app id but not the whole row. Falling through to
    // "unbound" here made a completed scan look like it had failed, because
    // nothing else populated the binding map until a refetch happened.
    const state = deriveAgentBindingState("ag_1", undefined, {
      s1: session("ag_1", "succeeded", { appId: "cli_9", bindingId: "cb_9" })
    });
    expect(state.kind).toBe("bound");
    if (state.kind !== "bound") return;
    expect(state.appId).toBe("cli_9");
    expect(state.bindingId).toBe("cb_9");
  });

  it("still reports bound when a success event carried no app id", () => {
    const state = deriveAgentBindingState("ag_1", undefined, { s1: session("ag_1", "succeeded") });
    expect(state.kind).toBe("bound");
    if (state.kind !== "bound") return;
    expect(state.bindingId).toBeNull();
  });

  it("takes the app id from the stored binding when one exists", () => {
    const state = deriveAgentBindingState("ag_1", binding("ag_1", "cli_from_row"), {});
    expect(state.kind).toBe("bound");
    if (state.kind !== "bound") return;
    expect(state.appId).toBe("cli_from_row");
    expect(state.bindingId).toBe("cb_1");
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

describe("describeLauncherWindow", () => {
  it("phrases an unknown deadline as ready rather than expired", () => {
    // `expiresAt: 0` means the client never learned the deadline — a session it
    // heard about from the stream. Rendering the countdown anyway produced the
    // nonsense "链接剩余 已过期" while the QR stayed on screen.
    expect(describeLauncherWindow(0, 1_000_000)).toBe("链接已就绪");
  });

  it("distinguishes expired from unknown", () => {
    expect(describeLauncherWindow(500, 1_000)).toBe("链接已过期");
  });

  it("counts down while the window is open", () => {
    expect(describeLauncherWindow(1_000 + 65_000, 1_000)).toBe("链接剩余 1:05");
  });
});

describe("shouldRefreshBindings", () => {
  it("asks for a refetch when a success event names a row we do not hold", () => {
    expect(
      shouldRefreshBindings({ s1: session("ag_1", "succeeded", { bindingId: "cb_1" }) }, {})
    ).toBe(true);
  });

  it("asks for a refetch when we hold a *different* binding than the event named", () => {
    // The stale-row case: a plain "do we have a binding?" test says yes and the
    // row would keep showing the old app id forever.
    const stale = { ag_1: binding("ag_1", "cli_old") };
    expect(
      shouldRefreshBindings({ s1: session("ag_1", "succeeded", { bindingId: "cb_new" }) }, stale)
    ).toBe(true);
  });

  it("stays quiet once the row matches", () => {
    // This is what stops the effect from looping.
    const current = { ag_1: binding("ag_1") };
    expect(
      shouldRefreshBindings({ s1: session("ag_1", "succeeded", { bindingId: "cb_1" }) }, current)
    ).toBe(false);
  });

  it("stays quiet for sessions that are not successes, and for unattributed successes", () => {
    expect(shouldRefreshBindings({ s1: session("ag_1", "awaiting_scan") }, {})).toBe(false);
    expect(shouldRefreshBindings({ s1: session("ag_1", "failed") }, {})).toBe(false);
    // No row id means nothing to compare against.
    expect(shouldRefreshBindings({ s1: session("ag_1", "succeeded") }, {})).toBe(false);
  });
});

describe("isSafeLauncherUrl", () => {
  it("accepts the https launcher the server actually returns", () => {
    expect(isSafeLauncherUrl("https://open.feishu.cn/page/launcher?user_code=X")).toBe(true);
  });

  it("rejects scheme that could navigate or execute", () => {
    // The value is rendered into an href, so the scheme is the dangerous part.
    expect(isSafeLauncherUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeLauncherUrl("http://open.feishu.cn/page/launcher")).toBe(false);
    expect(isSafeLauncherUrl("data:text/html,<script>x</script>")).toBe(false);
  });

  it("rejects missing and unparseable values", () => {
    expect(isSafeLauncherUrl(undefined)).toBe(false);
    expect(isSafeLauncherUrl("")).toBe(false);
    expect(isSafeLauncherUrl("not a url")).toBe(false);
  });
});
