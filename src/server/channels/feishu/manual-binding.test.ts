import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import {
  claimBindingOwner,
  clearClaimCodesForTests,
  bindFeishuWithCredentials,
  hasLiveClaim
} from "@/server/channels/feishu/binding";
import { getDatabase } from "@/db/client";
import { getChannelBindingForAgent } from "@/server/repositories";

/**
 * Binding from typed credentials. The scan flow gets the owner's open id for
 * free; this one does not, so it starts fail-closed and the owner is
 * established by a one-time code sent to the bot in the group.
 */
const connectBehavior = vi.hoisted(() => ({ mode: "ok" as "ok" | "fail" }));
const disconnected = vi.hoisted(() => ({ count: 0 }));

vi.mock("@larksuite/channel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@larksuite/channel")>();
  return {
    ...actual,
    createLarkChannel: () => ({
      connect: async () => {
        if (connectBehavior.mode === "fail") throw new Error("invalid app credentials");
      },
      disconnect: async () => {
        disconnected.count += 1;
      },
      getBotIdentity: () => ({ openId: "ou_the_bot", name: "绑定测试 Bot" })
    })
  };
});

let teardown: () => void;
const AGENT = "ag_pm";

/** The secret is deliberately absent from the public binding shape. */
function secretOf(agentId: string): string | undefined {
  const row = getDatabase()
    .prepare("SELECT app_secret FROM channel_bindings WHERE agent_id = ?")
    .get(agentId) as { app_secret: string } | undefined;
  return row?.app_secret;
}

beforeEach(() => {
  teardown = setupTestDatabase("agentmeld-manual-binding-");
  clearClaimCodesForTests();
  connectBehavior.mode = "ok";
  disconnected.count = 0;
});

afterEach(() => {
  clearClaimCodesForTests();
  teardown();
});

describe("binding from credentials", () => {
  it("stores the binding with the bot's identity and no owner yet", async () => {
    const result = await bindFeishuWithCredentials({
      agentId: AGENT,
      appId: "cli_typed",
      appSecret: "secret_typed"
    });

    expect(result.ok).toBe(true);
    const binding = getChannelBindingForAgent(AGENT, "feishu");
    expect(binding).toMatchObject({
      appId: "cli_typed",
      botOpenId: "ou_the_bot",
      // Fail-closed: nothing may be answered until the code comes back.
      boundByOpenId: null
    });
    // The secret is stored but never part of the public shape.
    expect(secretOf(AGENT)).toBe("secret_typed");
    // The credentials were checked, and the probe connection was closed.
    expect(disconnected.count).toBe(1);
    expect(result.claim?.code).toMatch(/^\d{6}$/);
  });

  it("refuses credentials that cannot connect, and stores nothing", async () => {
    connectBehavior.mode = "fail";
    const result = await bindFeishuWithCredentials({
      agentId: AGENT,
      appId: "cli_bad",
      appSecret: "nope"
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not connect");
    expect(getChannelBindingForAgent(AGENT, "feishu")).toBeFalsy();
    expect(hasLiveClaim(AGENT)).toBe(false);
  });

  it("refuses an unknown agent", async () => {
    const result = await bindFeishuWithCredentials({
      agentId: "ag_nobody",
      appId: "cli_x",
      appSecret: "s"
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });
});

describe("claiming the binding with the one-time code", () => {
  async function bind() {
    const result = await bindFeishuWithCredentials({
      agentId: AGENT,
      appId: "cli_typed",
      appSecret: "secret_typed"
    });
    if (!result.ok || !result.claim) throw new Error("expected a claim");
    return result.claim.code;
  }

  it("records the owner without touching the stored secret", async () => {
    const code = await bind();

    const outcome = claimBindingOwner({ agentId: AGENT, openId: "ou_owner", code });

    expect(outcome.ok).toBe(true);
    const binding = getChannelBindingForAgent(AGENT, "feishu");
    expect(binding?.boundByOpenId).toBe("ou_owner");
    // The claim must not rewrite the row wholesale: an upsert with the fields
    // this flow has at hand would blank the secret and break the connection.
    expect(secretOf(AGENT)).toBe("secret_typed");
    expect(binding?.botOpenId).toBe("ou_the_bot");
  });

  it("is single use", async () => {
    const code = await bind();
    expect(claimBindingOwner({ agentId: AGENT, openId: "ou_first", code }).ok).toBe(true);

    const second = claimBindingOwner({ agentId: AGENT, openId: "ou_second", code });

    expect(second).toMatchObject({ ok: false, reason: "no-claim" });
    expect(getChannelBindingForAgent(AGENT, "feishu")?.boundByOpenId).toBe("ou_first");
  });

  it("caps wrong guesses and invalidates the code", async () => {
    await bind();
    for (let i = 0; i < 4; i += 1) {
      expect(claimBindingOwner({ agentId: AGENT, openId: "ou_x", code: "000000" })).toMatchObject({
        ok: false,
        reason: "wrong-code"
      });
    }

    expect(claimBindingOwner({ agentId: AGENT, openId: "ou_x", code: "000000" })).toMatchObject({
      ok: false,
      reason: "too-many"
    });
    expect(hasLiveClaim(AGENT)).toBe(false);
    expect(getChannelBindingForAgent(AGENT, "feishu")?.boundByOpenId).toBeNull();
  });

  it("refuses an expired code", async () => {
    const code = await bind();
    const outcome = claimBindingOwner({
      agentId: AGENT,
      openId: "ou_owner",
      code,
      now: Date.now() + 6 * 60_000
    });
    expect(outcome).toMatchObject({ ok: false, reason: "expired" });
    expect(hasLiveClaim(AGENT)).toBe(false);
  });

  it("refuses a claim with no code outstanding", () => {
    expect(claimBindingOwner({ agentId: AGENT, openId: "ou_owner", code: "123456" })).toMatchObject({
      ok: false,
      reason: "no-claim"
    });
  });

  it("keeps one claim per agent: a new code replaces the old one", async () => {
    const first = await bind();
    const second = await bind();

    expect(first).not.toBe(second);
    expect(claimBindingOwner({ agentId: AGENT, openId: "ou_owner", code: first })).toMatchObject({
      ok: false,
      reason: "wrong-code"
    });
    expect(claimBindingOwner({ agentId: AGENT, openId: "ou_owner", code: second }).ok).toBe(true);
  });
});
