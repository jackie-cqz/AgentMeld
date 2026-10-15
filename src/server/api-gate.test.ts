import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests } from "@/db/client";
import { getDatabase } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import {
  describePrincipal,
  createPairingCode,
  hasPairedOwner,
  listSessions,
  redeemPairingCode,
  revokeSession,
  resolvePrincipal
} from "@/server/auth";
import { gateRequest } from "@/server/api-gate";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-auth-gate-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetDatabaseForTests();
  eventBus.clearForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetDatabaseForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const anyUrl = "http://localhost/api/conversations";

describe("the gate", () => {
  it("denies everything but the pairing routes before the first pairing", async () => {
    const gate = await gateRequest(new Request(anyUrl));
    expect(gate.allowed).toBe(false);
    expect(gate.response?.status).toBe(503);
  });

  it("lets an anonymous caller reach status and redemption, always", async () => {
    for (const pathname of ["/api/auth/status", "/api/auth/pair"]) {
      const gate = await gateRequest(new Request(`http://localhost${pathname}`, { method: "POST" }));
      expect(gate.allowed).toBe(true);
    }
  });

  it("closes the bootstrap window once an owner has paired", async () => {
    pair();
    const gate = await gateRequest(new Request(anyUrl));
    expect(gate.allowed).toBe(false);
    expect(gate.response?.status).toBe(401);
    // And minting a code anonymously stops working:
    const mint = await gateRequest(new Request("http://localhost/api/auth/pair/code", { method: "POST" }));
    expect(mint.allowed).toBe(false);
    expect(mint.response?.status).toBe(401);
  });

  it("accepts a request that carries a live session cookie", async () => {
    const cookie = pair();
    const gate = await gateRequest(new Request(anyUrl, { headers: { cookie } }));
    expect(gate.allowed).toBe(true);
    expect(gate.principal.kind).toBe("owner-session");
  });

  it("refuses a revoked session's cookie", async () => {
    const cookie = pair();
    const [session] = listSessions();
    expect(revokeSession(session.id)).toBe(true);

    const gate = await gateRequest(new Request(anyUrl, { headers: { cookie } }));
    expect(gate.allowed).toBe(false);
    expect(gate.response?.status).toBe(401);
  });

  it("refuses a session whose sliding window has lapsed", async () => {
    pair();
    // Insert a session whose token we know, then age its last_seen_at past
    // the 30-day sliding TTL. The lookup key still matches — what must fail
    // is the freshness check on the row, not the cookie.
    const { sha256Token } = await import("@/server/auth");
    const token = "lapsed-" + "c".repeat(40);
    const now = Date.now();
    getDatabase()
      .prepare("INSERT INTO owner_sessions (id, token_hash, created_at, last_seen_at, label) VALUES (?, ?, ?, ?, ?)")
      .run("os_lapsed", sha256Token(token), now - 31 * 24 * 3600 * 1000, now - 31 * 24 * 3600 * 1000, "test");
    const gate = await gateRequest(
      new Request(anyUrl, { headers: { cookie: `agentmeld_session=${token}` } })
    );
    expect(gate.allowed).toBe(false);
    expect(gate.response?.status).toBe(401);
  });

  it("refuses a session cookie that was never issued", async () => {
    pair();
    const gate = await gateRequest(
      new Request(anyUrl, { headers: { cookie: "agentmeld_session=forged-token" } })
    );
    expect(gate.allowed).toBe(false);
  });

  it("accepts the companion device token via Authorization", async () => {
    pair();
    const token = "dev_" + "a".repeat(40);
    getDatabase()
      .prepare("UPDATE app_settings SET mobile_device_token = ? WHERE id = 'singleton'")
      .run(token);

    const gate = await gateRequest(new Request(anyUrl, { headers: { authorization: `Bearer ${token}` } }));
    expect(gate.allowed).toBe(true);
    expect(gate.principal.kind).toBe("device-token");
  });

  it("refuses a wrong device token", async () => {
    pair();
    getDatabase()
      .prepare("UPDATE app_settings SET mobile_device_token = ? WHERE id = 'singleton'")
      .run("dev_" + "a".repeat(40));

    const gate = await gateRequest(
      new Request(anyUrl, { headers: { authorization: `Bearer ${"dev_" + "b".repeat(40)}` } })
    );
    expect(gate.allowed).toBe(false);
  });
});

describe("pairing codes", () => {
  it("issues six digits and redeems exactly once", () => {
    const { code } = createPairingCode();
    expect(code).toMatch(/^\d{6}$/);

    expect(hasPairedOwner()).toBe(false);
    const first = redeemPairingCode(code);
    expect(first.ok).toBe(true);
    expect(hasPairedOwner()).toBe(true);

    const second = redeemPairingCode(code);
    expect(second.ok).toBe(false);
  });

  it("replacing the code kills the previous one", () => {
    // Redeem BOTH codes' fates: the first mint's code must be dead the moment
    // a second one is issued. (An earlier version of this test never tried
    // the first code — it passed even when stale codes stayed redeemable.)
    const first = createPairingCode();
    const second = createPairingCode();
    expect(redeemPairingCode(first.code).ok).toBe(false);
    expect(redeemPairingCode(second.code).ok).toBe(true);
    expect(hasPairedOwner()).toBe(true);
  });

  it("refuses an expired code with 410", () => {
    const { code } = createPairingCode();
    // Backdate the live entry past its TTL, as time passing would.
    const codes = globalThis.__agentMeldPairingCodes!;
    codes.set("current", { ...codes.get("current")!, expiresAt: Date.now() - 1 });
    const result = redeemPairingCode(code);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(410);
    expect(hasPairedOwner()).toBe(false);
  });

  it("sets the session cookie with HttpOnly, SameSite=Strict and Path=/", () => {
    const { code } = createPairingCode();
    const result = redeemPairingCode(code);
    expect(result.ok).toBe(true);
    const cookie = result.setCookie ?? "";
    for (const attribute of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age="]) {
      expect(cookie).toContain(attribute);
    }
  });

  it("caps wrong attempts and says so", () => {
    const { code } = createPairingCode();
    let last: ReturnType<typeof redeemPairingCode> | null = null;
    for (let i = 0; i < 5; i++) {
      last = redeemPairingCode("000000" === code ? "111111" : "000000");
    }
    expect(last?.ok).toBe(false);
    expect(last?.status).toBe(429);
    // Even the right code is dead after the cap:
    expect(redeemPairingCode(code).ok).toBe(false);
  });

  it("a redeemed code leaves no owner-unpaired window open", () => {
    const { code } = createPairingCode();
    redeemPairingCode(code);
    expect(hasPairedOwner()).toBe(true);
  });
});

describe("describePrincipal", () => {
  it("names an owner session by its id", () => {
    expect(describePrincipal({ kind: "owner-session", sessionId: "os_abc", createdAt: 1 }))
      .toBe("owner:session:os_abc");
  });

  it("names a companion device", () => {
    expect(describePrincipal({ kind: "device-token", label: "companion" })).toBe("device:companion");
  });

  it("uses ONE Feishu format, with the operator in it", () => {
    // There used to be two: `feishu:<appId>` here and `feishu:<appId>:<openId>`
    // on the card-action path. An app-only string would put an application
    // where a person belongs, so this pins the shared shape.
    expect(describePrincipal({ kind: "feishu-binding", appId: "cli_pm", openId: "ou_x" }))
      .toBe("feishu:cli_pm:ou_x");
  });

  it("leaves an anonymous caller unattributed", () => {
    // NULL in the column, not the word "anonymous" reading later like a name.
    expect(describePrincipal({ kind: "anonymous" })).toBeNull();
  });
});

describe("resolvePrincipal", () => {
  it("returns anonymous for a request with nothing on it", async () => {
    const principal = await resolvePrincipal(new Request(anyUrl));
    expect(principal.kind).toBe("anonymous");
  });

  it("does not treat unrelated cookies as a session", async () => {
    const principal = await resolvePrincipal(
      new Request(anyUrl, { headers: { cookie: "other=1; agentmeld_session=nope" } })
    );
    expect(principal.kind).toBe("anonymous");
  });
});

/** Pair a synthetic owner and return the cookie its requests carry. */
function pair(): string {
  const { code } = createPairingCode();
  const result = redeemPairingCode(code);
  if (!result.ok || !result.setCookie) throw new Error("test pairing failed");
  return result.setCookie.split(";")[0];
}
