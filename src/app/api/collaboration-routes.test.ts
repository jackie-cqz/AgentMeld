import { beforeEach, describe, expect, it } from "vitest";
import { createPairingCode, redeemPairingCode } from "@/server/auth";
import { POST as propose } from "./task-handoffs/route";
import { GET as inspectHandoff, POST as decide } from "./task-handoffs/[id]/route";
import { POST as resolve } from "./collaboration-turns/[id]/resolve/route";
import { GET as inspectContext } from "./collaboration-turns/[id]/context/route";
import { getDatabase } from "@/db/client";

let cookie = "";
beforeEach(() => {
  const result = redeemPairingCode(createPairingCode().code);
  if (!result.ok || !result.setCookie) throw new Error("Fixture pairing failed.");
  cookie = result.setCookie.split(";")[0];
});
const context = { params: Promise.resolve({ id: "missing-fixture" }) };
function request(path: string, body?: unknown, authenticated = false) {
  return new Request(`http://localhost/api/${path}`, { method: body ? "POST" : "GET",
    headers: { ...(authenticated ? { cookie } : {}), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

describe("collaboration control routes", () => {
  it("requires authentication for every new control and private context read", async () => {
    expect((await propose(request("task-handoffs", {}))).status).toBe(401);
    expect((await decide(request("task-handoffs/missing", {}), context)).status).toBe(401);
    expect((await inspectHandoff(request("task-handoffs/missing"), context)).status).toBe(401);
    expect((await resolve(request("collaboration-turns/missing/resolve", {}), context)).status).toBe(401);
    expect((await inspectContext(request("collaboration-turns/missing/context"), context)).status).toBe(401);
  });

  it("rejects client-supplied authority, status, contract and actor fields", async () => {
    const count = () => (getDatabase().prepare("SELECT COUNT(*) AS n FROM task_handoffs").get() as { n: number }).n;
    const before = count();
    expect((await propose(request("task-handoffs", { sourceAttemptId: "attempt", targetAgentId: "ag_designer", status: "accepted", package: {}, origin: "human" }, true))).status).toBe(400);
    expect((await decide(request("task-handoffs/missing", { decision: "accept", resolvedBy: "owner:forged" }, true), context)).status).toBe(400);
    expect((await resolve(request("collaboration-turns/missing/resolve", { action: "new_task", actor: "owner:forged" }, true), context)).status).toBe(400);
    expect(count()).toBe(before);
  });

  it("does not expose nonexistent handoff packages or context snapshots", async () => {
    expect((await inspectHandoff(request("task-handoffs/missing", undefined, true), context)).status).toBe(404);
    expect((await inspectContext(request("collaboration-turns/missing/context", undefined, true), context)).status).toBe(404);
  });
});
