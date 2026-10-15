import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RequestOptions } from "node:https";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", () => ({ default: { request: mocks.request } }));
vi.mock("node:https", () => ({ default: { request: mocks.request } }));
import { publicRequest } from "@/server/tools/public-web";
import { webSearchTool } from "@/server/tools/web";
import type { ToolContext } from "@/server/tools/types";
const ctx: ToolContext = { conversationId: "c", agentId: "a", runId: "r", workspacePath: ".", abortSignal: new AbortController().signal };
type Reply = { status?: number; location?: string; body?: string; type?: string };
let replies: Reply[];
beforeEach(() => {
  replies = []; mocks.request.mockReset(); mocks.lookup.mockReset();
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  mocks.request.mockImplementation((_url: URL, options: RequestOptions, onResponse: (response: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => queueMicrotask(() => {
      const reply = replies.shift() ?? {};
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, unknown>; destroy: (error: Error) => void };
      res.statusCode = reply.status ?? 200; res.headers = { "content-type": reply.type ?? "text/plain", location: reply.location };
      res.destroy = error => res.emit("error", error);
      onResponse(res); res.emit("data", Buffer.from(reply.body ?? "public text")); res.emit("end");
    });
    // Simulate Node's all-address lookup mode, which must still use the vetted address.
    options.lookup?.("example.com", { all: true }, (error, address) => { expect(error).toBeNull(); expect(address).toEqual([{ address: "8.8.8.8", family: 4 }]); });
    return req;
  });
});
describe("pinned web transport", () => {
  it("pins DNS and parses the terminal response", async () => {
    expect(await publicRequest("https://example.com/docs", ctx.abortSignal)).toMatchObject({ url: "https://example.com/docs", status: 200, body: "public text" });
    expect(mocks.lookup).toHaveBeenCalledTimes(1); expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("rejects a redirect into loopback before opening another connection", async () => {
    replies.push({ status: 302, location: "http://127.0.0.1/private" });
    await expect(publicRequest("https://example.com", ctx.abortSignal)).rejects.toThrow(/blocked/);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("re-resolves and validates each public redirect", async () => {
    replies.push({ status: 301, location: "https://docs.example.com/path" }, { body: "docs" });
    expect(await publicRequest("https://example.com", ctx.abortSignal)).toMatchObject({ url: "https://docs.example.com/path", body: "docs" }); expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });
  it("rejects mixed private/public DNS and prevents credential redirects", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]);
    await expect(publicRequest("https://example.com", ctx.abortSignal)).rejects.toThrow(/mixed/); expect(mocks.request).not.toHaveBeenCalled();
    replies.push({ status: 302, location: "https://evil.example" });
    await expect(publicRequest("https://example.com", ctx.abortSignal, { headers: { "X-Subscription-Token": "fixture-secret" } })).rejects.toThrow(/Redirect/);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("bounds body size and aborts before any connection", async () => {
    replies.push({ body: "x".repeat(1024 * 1024 + 1) });
    await expect(publicRequest("https://example.com", ctx.abortSignal)).rejects.toThrow(/1 MiB/);
    const controller = new AbortController(); controller.abort();
    await expect(publicRequest("https://example.com", controller.signal)).rejects.toThrow(); expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("can abort a stalled DNS lookup before opening a connection", async () => {
    mocks.lookup.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController(); const result = publicRequest("https://example.com", controller.signal);
    const assertion = expect(result).rejects.toThrow(); controller.abort(); await assertion; expect(mocks.request).not.toHaveBeenCalled();
  });
  it("uses a dedicated search key and returns bounded untrusted source leads", async () => {
    vi.stubEnv("AGENTMELD_BRAVE_SEARCH_API_KEY", "fixture-secret");
    replies.push({ type: "application/json", body: JSON.stringify({ web: { results: [{ title: "Docs", url: "https://example.com/docs", description: "<b>Source</b>" }] } }) });
    try {
      const result = await webSearchTool.handler({ query: "API docs", limit: 1 }, ctx);
      expect(result).toMatchObject({ ok: true, value: { untrusted: true, provider: "brave", results: [{ title: "Docs", url: "https://example.com/docs", snippet: "Source" }] } });
      expect(JSON.stringify(result)).not.toContain("fixture-secret"); expect(mocks.request.mock.calls[0][1].headers["X-Subscription-Token"]).toBe("fixture-secret");
    } finally { vi.unstubAllEnvs(); }
  });
});
