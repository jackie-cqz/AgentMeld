import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "@/db/client";
import { setupTestDatabase } from "@/test/test-database";
import { eventBus } from "@/server/event-bus";
import {
  clearBindingSessionsForTests,
  getBindingSession,
  listBindingSessions,
  cancelBindingSession,
  startFeishuBinding,
  unbindAgent
} from "@/server/channels/feishu/binding";
import {
  getChannelBindingForAgent,
  getChannelBindingSecret,
  getAgent,
  listChannelBindings
} from "@/server/repositories";
import type { StreamEvent } from "@/shared/types";

// `vi.mock` is hoisted, so the factory cannot close over a plain `const`.
const { registerAppMock } = vi.hoisted(() => ({ registerAppMock: vi.fn() }));
vi.mock("@larksuite/channel", () => ({ registerApp: registerAppMock }));

type RegisterOptions = {
  onQRCodeReady: (info: { url: string; expireIn: number }) => void;
  onStatusChange?: (info: { status: string }) => void;
  signal?: AbortSignal;
  appPreset?: { name?: string; desc?: string };
  createOnly?: boolean;
};

let cleanupDatabase: (() => void) | undefined;

beforeAll(() => {
  cleanupDatabase = setupTestDatabase("agentmeld-channel-binding-");
});

afterAll(() => {
  cleanupDatabase?.();
});

beforeEach(() => {
  eventBus.clearForTests();
  clearBindingSessionsForTests();
  registerAppMock.mockReset();
  // The database is created once for the file, so bindings would otherwise leak
  // between cases and every later start would correctly answer 409.
  getDatabase().prepare("DELETE FROM channel_bindings").run();
});

afterEach(() => {
  clearBindingSessionsForTests();
  eventBus.clearForTests();
});

/** Let the detached registerApp continuation run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function successResult() {
  return {
    client_id: "cli_test_app",
    client_secret: "secret_must_not_escape",
    user_info: { open_id: "ou_owner", tenant_brand: "feishu" }
  };
}

describe("startFeishuBinding", () => {
  it("returns the launcher URL and the expiry the SDK reported", async () => {
    // Deliberately never settles: the user has not scanned yet, which is the
    // state the start response is actually observed in. (With an instantly
    // resolving registration the session can already be 'succeeded' here, so a
    // client must tolerate both.)
    registerAppMock.mockImplementation((options: RegisterOptions) => {
      options.onQRCodeReady({ url: "https://open.feishu.cn/page/launcher?user_code=TEST", expireIn: 3600 });
      return new Promise(() => {});
    });

    const result = await startFeishuBinding("ag_mock_builder");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.session.qrUrl).toBe("https://open.feishu.cn/page/launcher?user_code=TEST");
    // 3600 seconds, per the flow itself — not the ten minutes the overview
    // page claims. The binding session must follow the value it is given.
    expect(result.session.expiresAt).toBeGreaterThan(Date.now() + 3500 * 1000);
    expect(result.session.status).toBe("awaiting_scan");
  });

  it("inherits the agent's name and description, and asks for a new app only", async () => {
    registerAppMock.mockImplementation(async (options: RegisterOptions) => {
      options.onQRCodeReady({ url: "https://example.test/x", expireIn: 60 });
      return successResult();
    });

    await startFeishuBinding("ag_mock_builder");

    const options = registerAppMock.mock.calls[0][0] as RegisterOptions;
    expect(options.createOnly).toBe(true);

    // Compare against the agent's actual identity, not just "something truthy":
    // a preset carrying an unrelated name previously passed this test.
    const agent = getAgent("ag_mock_builder");
    expect(agent).toBeDefined();
    expect(options.appPreset?.name).toBe(agent!.name);
    expect(options.appPreset?.desc).toBe(agent!.description);

    // The avatar is deliberately not attempted: agents store an emoji and the
    // preset needs an image URL.
    expect(options.appPreset).not.toHaveProperty("avatar");
  });

  it("persists the binding and reports success once the scan completes", async () => {
    registerAppMock.mockImplementation(async (options: RegisterOptions) => {
      options.onQRCodeReady({ url: "https://example.test/x", expireIn: 60 });
      return successResult();
    });

    const result = await startFeishuBinding("ag_mock_builder");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sessionId = result.session.id;

    await flush();

    const session = getBindingSession(sessionId);
    expect(session?.status).toBe("succeeded");

    const binding = getChannelBindingForAgent("ag_mock_builder", "feishu");
    expect(binding?.appId).toBe("cli_test_app");
    expect(binding?.tenantBrand).toBe("feishu");
    expect(binding?.boundByOpenId).toBe("ou_owner");

    // The secret is stored but must never appear on the binding object.
    expect(binding && "appSecret" in binding).toBe(false);
    expect(JSON.stringify(binding)).not.toContain("secret_must_not_escape");
    expect(getChannelBindingSecret(binding!.id)).toBe("secret_must_not_escape");
  });

  it("publishes a status event that does not carry the launcher URL", async () => {
    registerAppMock.mockImplementation(async (options: RegisterOptions) => {
      options.onQRCodeReady({ url: "https://example.test/secret_launcher", expireIn: 60 });
      return successResult();
    });

    const events: StreamEvent[] = [];
    eventBus.subscribe((entry) => events.push(entry.event));

    await startFeishuBinding("ag_mock_builder");
    await flush();

    const updates = events.filter((event) => event.type === "channel.binding.updated");
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1]).toMatchObject({ status: "succeeded", appId: "cli_test_app" });
    // Whoever holds the launcher URL first can create the app, so it stays out
    // of the broadcast and only appears in the start response.
    expect(JSON.stringify(events)).not.toContain("secret_launcher");
  });

  it("records a failure without creating a binding", async () => {
    registerAppMock.mockImplementation(async (options: RegisterOptions) => {
      options.onQRCodeReady({ url: "https://example.test/x", expireIn: 60 });
      throw Object.assign(new Error("denied"), { code: "access_denied", description: "用户拒绝了授权" });
    });

    const result = await startFeishuBinding("ag_mock_builder");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await flush();

    const session = getBindingSession(result.session.id);
    expect(session?.status).toBe("failed");
    expect(session?.error).toContain("access_denied");
    expect(getChannelBindingForAgent("ag_mock_builder", "feishu")).toBeUndefined();
  });

  it("fails the request when no launcher URL ever arrives", async () => {
    registerAppMock.mockImplementation(() => Promise.reject(new Error("network down")));

    const result = await startFeishuBinding("ag_mock_builder");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(listBindingSessions().every((session) => session.status !== "awaiting_scan")).toBe(true);
  });

  it("refuses a second binding for an agent that already has one", async () => {
    registerAppMock.mockImplementation(async (options: RegisterOptions) => {
      options.onQRCodeReady({ url: "https://example.test/x", expireIn: 60 });
      return successResult();
    });

    await startFeishuBinding("ag_mock_builder");
    await flush();

    const second = await startFeishuBinding("ag_mock_builder");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);
  });

  it("rejects an unknown agent", async () => {
    const result = await startFeishuBinding("ag_does_not_exist");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(registerAppMock).not.toHaveBeenCalled();
  });
});

describe("cancelBindingSession", () => {
  it("aborts the in-flight registration and marks the session cancelled", async () => {
    let captured: RegisterOptions | undefined;
    registerAppMock.mockImplementation((options: RegisterOptions) => {
      captured = options;
      options.onQRCodeReady({ url: "https://example.test/x", expireIn: 60 });
      // Never settles: the user has not scanned yet.
      return new Promise(() => {});
    });

    const result = await startFeishuBinding("ag_mock_builder");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(captured?.signal?.aborted).toBe(false);
    expect(cancelBindingSession(result.session.id)?.status).toBe("cancelled");

    expect(captured?.signal?.aborted).toBe(true);
    expect(getBindingSession(result.session.id)?.status).toBe("cancelled");
    expect(getChannelBindingForAgent("ag_mock_builder", "feishu")).toBeUndefined();
  });

  it("returns undefined for an unknown session", () => {
    expect(cancelBindingSession("cbs_missing")).toBeUndefined();
  });
});

describe("unbindAgent", () => {
  it("removes the local binding and reports the app it left behind", async () => {
    registerAppMock.mockImplementation(async (options: RegisterOptions) => {
      options.onQRCodeReady({ url: "https://example.test/x", expireIn: 60 });
      return successResult();
    });

    await startFeishuBinding("ag_mock_builder");
    await flush();
    expect(listChannelBindings()).toHaveLength(1);

    expect(unbindAgent("ag_mock_builder")).toBe(true);
    expect(listChannelBindings()).toHaveLength(0);
    // There is no confirmed API for deleting the Feishu app, so unbinding must
    // not be presented as cleaning it up.
    expect(unbindAgent("ag_mock_builder")).toBe(false);
  });
});

describe("review regressions", () => {
  it("drops the launcher URL as soon as the attempt settles", async () => {
    // It used to survive on the session, so GET /sessions/[id] handed out a
    // spent launcher URL even after success.
    registerAppMock.mockImplementation(async (options: RegisterOptions) => {
      options.onQRCodeReady({ url: "https://example.test/spent", expireIn: 60 });
      return successResult();
    });

    const started = await startFeishuBinding("ag_mock_builder");
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await flush();

    const session = getBindingSession(started.session.id);
    expect(session?.status).toBe("succeeded");
    expect(session).not.toHaveProperty("qrUrl");
  });

  it("distinguishes the session id from the persisted binding id in events", async () => {
    registerAppMock.mockImplementation(async (options: RegisterOptions) => {
      options.onQRCodeReady({ url: "https://example.test/x", expireIn: 60 });
      return successResult();
    });

    const events: StreamEvent[] = [];
    eventBus.subscribe((entry) => events.push(entry.event));

    const started = await startFeishuBinding("ag_mock_builder");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await flush();

    const updates = events.filter((event) => event.type === "channel.binding.updated");
    const final = updates[updates.length - 1];
    if (final?.type !== "channel.binding.updated") throw new Error("no update event");

    // The event used to report the session id under the name `bindingId`, so no
    // consumer could have matched an event to a stored row.
    expect(final.sessionId).toBe(started.session.id);
    const binding = getChannelBindingForAgent("ag_mock_builder", "feishu");
    expect(final.bindingId).toBe(binding?.id);
    expect(final.bindingId).not.toBe(final.sessionId);
  });

  it("refuses a second concurrent attempt instead of creating a second app", async () => {
    // Both used to pass the "already bound" check and both called registerApp,
    // leaving an orphan Feishu app behind with no API to delete it.
    registerAppMock.mockImplementation((options: RegisterOptions) => {
      options.onQRCodeReady({ url: "https://example.test/x", expireIn: 600 });
      return new Promise(() => {});
    });

    const [first, second] = await Promise.all([
      startFeishuBinding("ag_mock_builder"),
      startFeishuBinding("ag_mock_builder")
    ]);

    const results = [first, second];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const refused = results.find((result) => !result.ok);
    expect(refused && !refused.ok && refused.status).toBe(409);
    // The caller is told which attempt to watch instead.
    expect(refused && !refused.ok && refused.sessionId).toMatch(/^cbs_/);
    expect(registerAppMock).toHaveBeenCalledTimes(1);
  });

  it("does not persist a binding when the attempt is cancelled after the SDK resolved", async () => {
    let settleSdk: ((value: unknown) => void) | undefined;
    registerAppMock.mockImplementation((options: RegisterOptions) => {
      options.onQRCodeReady({ url: "https://example.test/x", expireIn: 600 });
      return new Promise((resolve) => {
        settleSdk = resolve;
      });
    });

    const started = await startFeishuBinding("ag_mock_builder");
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    cancelBindingSession(started.session.id);
    // The SDK resolves only now — after the user asked to stop.
    settleSdk?.(successResult());
    await flush();

    expect(getBindingSession(started.session.id)?.status).toBe("cancelled");
    expect(getChannelBindingForAgent("ag_mock_builder", "feishu")).toBeUndefined();
  });

  it("ignores a launcher URL that arrives after the attempt already failed", async () => {
    let lateOptions: RegisterOptions | undefined;
    registerAppMock.mockImplementation((options: RegisterOptions) => {
      lateOptions = options;
      // The first URL lets the start call resolve; the second is the late one.
      options.onQRCodeReady({ url: "https://example.test/first", expireIn: 600 });
      return new Promise(() => {});
    });

    const started = await startFeishuBinding("ag_mock_builder");
    if (!started.ok) throw new Error("expected an attempt");

    cancelBindingSession(started.session.id);
    const settledAt = getBindingSession(started.session.id)!;

    // A slow begin() can report the URL after we have given up.
    lateOptions?.onQRCodeReady({ url: "https://example.test/late", expireIn: 3600 });

    const after = getBindingSession(started.session.id)!;
    expect(after.status).toBe(settledAt.status);
    expect(after.expiresAt).toBe(settledAt.expiresAt);
    expect(after).not.toHaveProperty("qrUrl");
  });

  it("marks an expired attempt failed instead of deleting it while it is still running", async () => {
    // Deleting the session let an in-flight registration write its result into
    // a session nobody could read.
    registerAppMock.mockImplementation((options: RegisterOptions) => {
      options.onQRCodeReady({ url: "https://example.test/x", expireIn: 0 });
      return new Promise(() => {});
    });

    const started = await startFeishuBinding("ag_mock_builder");
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const session = getBindingSession(started.session.id);
    expect(session).toBeDefined();
    expect(session?.status).toBe("failed");
    expect(session?.error).toContain("expired");
  });
});
