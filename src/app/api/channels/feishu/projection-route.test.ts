import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authedRequest, pairTestOwner, resetTestAuth } from "@/test/auth-test-helper";
import { ensureDatabase } from "@/db/bootstrap";
import { GET, POST } from "@/app/api/channels/feishu/projection/route";
import { isChannelProjectionPaused } from "@/server/channels/feishu/projection";

/**
 * The switch has to be reachable.
 *
 * It was originally a server function with no caller: the code said "there is a
 * pause switch" and nothing could press it, which is the same as not having one.
 */
describe("POST /api/channels/feishu/projection", () => {
  afterEach(() => {
  resetTestAuth();
    // Never leak a paused state into another test file.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__agentMeldChannelProjectionPaused = undefined;
  });

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__agentMeldChannelProjectionPaused = undefined;
    ensureDatabase();
  pairTestOwner();
});

  const post = (body: unknown) =>
    POST(
      authedRequest("http://localhost/api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      })
    );

  it("reports the current state", async () => {
    const res = await GET(authedRequest("http://localhost/api/test"));
    expect(await res.json()).toEqual({ data: { paused: false } });
  });

  it("pauses and resumes", async () => {
    const paused = await post({ paused: true });
    expect(await paused.json()).toEqual({ data: { paused: true } });
    expect(isChannelProjectionPaused()).toBe(true);

    const resumed = await post({ paused: false });
    expect(await resumed.json()).toEqual({ data: { paused: false } });
    expect(isChannelProjectionPaused()).toBe(false);
  });

  it("refuses anything that is not a boolean", async () => {
    // A body like { paused: "yes" } must not read as true and silently stop
    // everything going out.
    const res = await post({ paused: "yes" });
    expect(res.status).toBe(400);
    expect(isChannelProjectionPaused()).toBe(false);
  });
});
