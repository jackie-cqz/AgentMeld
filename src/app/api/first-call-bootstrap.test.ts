import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authedRequest, pairTestOwner, resetTestAuth } from "@/test/auth-test-helper";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests } from "@/db/client";
import { GET as listAgents } from "@/app/api/agents/route";
import { DELETE as deleteBinding } from "@/app/api/channels/feishu/bindings/[id]/route";
import { GET as listBindings } from "@/app/api/channels/feishu/bindings/route";
import { GET as getSettings } from "@/app/api/settings/route";
import { clearBindingSessionsForTests } from "@/server/channels/feishu/binding";

/**
 * The first request a fresh installation receives must not blow up because
 * nothing has created the schema yet.
 *
 * Bootstrapping is lazy in this codebase — `ensureDatabase()` runs on the first
 * service call, not at process start (there is no instrumentation hook, despite
 * what docs/schema.md says). So every read path has to go through a function
 * that bootstraps. Routes that reached a repository function directly answered
 * 500 with "no such table: …" and then appeared to fix themselves, because some
 * later request bootstrapped the database in the meantime.
 *
 * The suite as a whole could not catch this: `src/test/setup-global-db.ts`
 * bootstraps once per file, so a route that forgets is never observed on an
 * unbootstrapped database. These tests each start from a brand-new directory.
 */
let dir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-first-call-"));
  previousDataDir = process.env.AGENTMELD_DATA_DIR;
  process.env.AGENTMELD_DATA_DIR = dir;
  // Fresh singletons pointing at an empty directory: no schema at all.
  resetBootstrapForTests();
  resetTestAuth();
  resetDatabaseForTests();
  ensureDatabase();
  pairTestOwner();
  clearBindingSessionsForTests();
});

afterEach(() => {
  resetBootstrapForTests();
  resetDatabaseForTests();
  clearBindingSessionsForTests();
  if (previousDataDir === undefined) delete process.env.AGENTMELD_DATA_DIR;
  else process.env.AGENTMELD_DATA_DIR = previousDataDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("first request against an unbootstrapped database", () => {
  it("lists channel bindings instead of failing with a missing table", async () => {
    const res = await listBindings(authedRequest("http://localhost/api/test"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { bindings: unknown[] } };
    expect(body.data.bindings).toEqual([]);
  });

  it("answers a binding delete with 404, not a 500 from a missing table", async () => {
    // The GET was fixed first and this path was missed, which is the whole
    // reason the flag lives in the service now rather than in one route.
    const res = await deleteBinding(
      authedRequest("http://localhost/api/test", { method: "DELETE" }),
      ctx("cb_missing")
    );
    expect(res.status).toBe(404);
  });

  it("lists agents", async () => {
    const res = await listAgents(authedRequest("http://localhost/api/test"));
    expect(res.status).toBe(200);
  });

  it("reads settings", async () => {
    const res = await getSettings(authedRequest("http://localhost/api/test"));
    expect(res.status).toBe(200);
  });
});
