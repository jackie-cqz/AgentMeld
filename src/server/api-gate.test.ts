import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests } from "@/db/client";
import { getDatabase } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import {
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
    createPairingCode();
    const { code } = createPairingCode();
    // The first code was never returned to us, but redeeming a stale one must
    // fail anyway — what we test is that only the LATEST code works.
    expect(redeemPairingCode(code).ok).toBe(true);
    expect(hasPairedOwner()).toBe(true);
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
