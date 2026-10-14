import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "@/db/client";
import { setupTestDatabase } from "@/test/test-database";
import { eventBus } from "@/server/event-bus";
import { clearBindingSessionsForTests } from "@/server/channels/feishu/binding";

const { registerAppMock } = vi.hoisted(() => ({ registerAppMock: vi.fn() }));
vi.mock("@larksuite/channel", () => ({ registerApp: registerAppMock }));

import { POST as startBinding, GET as listBindings } from "@/app/api/channels/feishu/bindings/route";
import { DELETE as deleteBinding } from "@/app/api/channels/feishu/bindings/[id]/route";
import { GET as getSession } from "@/app/api/channels/feishu/bindings/sessions/[id]/route";
import { POST as cancelSession } from "@/app/api/channels/feishu/bindings/sessions/[id]/cancel/route";

type RegisterOptions = {
  onQRCodeReady: (info: { url: string; expireIn: number }) => void;
};

let cleanupDatabase: (() => void) | undefined;

beforeAll(() => {
  cleanupDatabase = setupTestDatabase("agentmeld-channel-binding-routes-");
});

afterAll(() => {
  cleanupDatabase?.();
});

beforeEach(() => {
  eventBus.clearForTests();
  clearBindingSessionsForTests();
  registerAppMock.mockReset();
  getDatabase().prepare("DELETE FROM channel_bindings").run();
});

afterEach(() => {
  clearBindingSessionsForTests();
  eventBus.clearForTests();
});

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function pendingRegistration(url = "https://open.feishu.cn/page/launcher?user_code=R") {
  registerAppMock.mockImplementation((options: RegisterOptions) => {
    options.onQRCodeReady({ url, expireIn: 600 });
    return new Promise(() => {});
  });
}

function succeedingRegistration() {
  registerAppMock.mockImplementation(async (options: RegisterOptions) => {
    options.onQRCodeReady({ url: "https://open.feishu.cn/page/launcher?user_code=R", expireIn: 600 });
    return {
      client_id: "cli_route_app",
      client_secret: "route_secret",
      user_info: { open_id: "ou_route", tenant_brand: "feishu" }
    };
  });
}

describe("POST /api/channels/feishu/bindings", () => {
  it("returns the launcher URL for an agent", async () => {
    pendingRegistration();

    const res = await startBinding(jsonRequest({ agentId: "ag_mock_builder" }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { session: { id: string; qrUrl?: string; status: string } } };
    expect(body.data.session.id).toMatch(/^cbs_/);
    expect(body.data.session.qrUrl).toContain("open.feishu.cn/page/launcher");
  });

  it("rejects a body without an agentId", async () => {
    const res = await startBinding(jsonRequest({}));
    expect(res.status).toBe(400);
    expect(registerAppMock).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown agent", async () => {
    const res = await startBinding(jsonRequest({ agentId: "ag_nope" }));
    expect(res.status).toBe(404);
  });

  it("returns 409 when the agent is already bound", async () => {
    succeedingRegistration();

    const first = await startBinding(jsonRequest({ agentId: "ag_mock_builder" }));
    expect(first.status).toBe(200);
    await flush();

    const second = await startBinding(jsonRequest({ agentId: "ag_mock_builder" }));
    expect(second.status).toBe(409);
  });
});

describe("GET /api/channels/feishu/bindings", () => {
  it("never exposes the app secret", async () => {
    succeedingRegistration();
    await startBinding(jsonRequest({ agentId: "ag_mock_builder" }));
    await flush();

    const res = await listBindings();
    expect(res.status).toBe(200);

    const raw = await res.text();
    expect(raw).toContain("cli_route_app");
    expect(raw).not.toContain("route_secret");
  });
});

describe("GET /api/channels/feishu/bindings/sessions/[id]", () => {
  it("reports the session, and 404s for an unknown one", async () => {
    pendingRegistration();
    const started = await startBinding(jsonRequest({ agentId: "ag_mock_builder" }));
    const sessionId = ((await started.json()) as { data: { session: { id: string } } }).data.session.id;

    const res = await getSession(new Request("http://localhost/api/test"), ctx(sessionId));
    expect(res.status).toBe(200);

    const missing = await getSession(new Request("http://localhost/api/test"), ctx("cbs_missing"));
    expect(missing.status).toBe(404);
  });
});

describe("POST /api/channels/feishu/bindings/sessions/[id]/cancel", () => {
  it("cancels an in-flight attempt and reports its real status", async () => {
    pendingRegistration();
    const started = await startBinding(jsonRequest({ agentId: "ag_mock_builder" }));
    const sessionId = ((await started.json()) as { data: { session: { id: string } } }).data.session.id;

    const res = await cancelSession(new Request("http://localhost/api/test", { method: "POST" }), ctx(sessionId));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { session: { status: string } } };
    expect(body.data.session.status).toBe("cancelled");

    const missing = await cancelSession(new Request("http://localhost/api/test", { method: "POST" }), ctx("cbs_missing"));
    expect(missing.status).toBe(404);
  });

  it("reports cancellation honestly when the attempt already succeeded", async () => {
    succeedingRegistration();
    const started = await startBinding(jsonRequest({ agentId: "ag_mock_builder" }));
    const sessionId = ((await started.json()) as { data: { session: { id: string } } }).data.session.id;
    await flush();

    const res = await cancelSession(new Request("http://localhost/api/test", { method: "POST" }), ctx(sessionId));
    expect(res.status).toBe(200);

    // Never claim "cancelled" about a scan that already went through.
    const body = (await res.json()) as { data: { session: { status: string } } };
    expect(body.data.session.status).toBe("succeeded");
  });
});

describe("start failures", () => {
  it("answers 502 and still names the attempt when no launcher URL arrives", async () => {
    registerAppMock.mockImplementation(() => Promise.reject(new Error("network down")));

    const res = await startBinding(jsonRequest({ agentId: "ag_mock_builder" }));
    expect(res.status).toBe(502);

    // The session id comes back so the caller can watch or cancel the attempt
    // it just started; without it the failure would only exist on the stream.
    const body = (await res.json()) as { error: string; sessionId: string | null };
    expect(body.sessionId).toMatch(/^cbs_/);
  });
});

describe("DELETE /api/channels/feishu/bindings/[id]", () => {
  it("unbinds and names the app it leaves behind", async () => {
    succeedingRegistration();
    await startBinding(jsonRequest({ agentId: "ag_mock_builder" }));
    await flush();

    const listRes = await listBindings();
    const bindingId = ((await listRes.json()) as { data: { bindings: Array<{ id: string }> } }).data.bindings[0].id;

    const res = await deleteBinding(new Request("http://localhost/api/test", { method: "DELETE" }), ctx(bindingId));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { appLeftBehind: string } };
    // Unbinding must not imply the Feishu app was deleted.
    expect(body.data.appLeftBehind).toBe("cli_route_app");

    const again = await deleteBinding(new Request("http://localhost/api/test", { method: "DELETE" }), ctx(bindingId));
    expect(again.status).toBe(404);
  });
});
