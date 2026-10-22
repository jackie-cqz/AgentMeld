import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ evidence: [] as EvidenceRecord[] }));
vi.mock("@/server/repositories/evidence-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/repositories/evidence-repository")>();
  return { ...actual, insertEvidence: (record: EvidenceRecord) => { mocks.evidence.push(record); } };
});

import { createAgent } from "@/server/agent-service";
import { createConversation } from "@/server/conversation-service";
import { getWorkspaceForConversation } from "@/server/repositories";
import { newRunId } from "@/shared/ids";
import { createPiBridge } from "@/server/pi/bridge";
import { PI_NATIVE_TO_PLATFORM } from "@/server/pi/native-tools";
import { createOpenCodeToolEndpoint, OPENCODE_TOOL_PREFIX, type OpenCodeToolEndpoint } from "./opencode-mcp";
import type { EvidenceRecord } from "@/server/repositories/evidence-repository";
import type { TaskExecutionIdentity } from "@/shared/evidence-types";
import type { HarnessInvocationInput } from "./types";

/**
 * Parity and lifecycle proof for OpenCode's tool transport.
 *
 * The OpenCode path is exercised as the real thing: a real stdio MCP server
 * process (the one OpenCode spawns) talking to a real invocation-scoped
 * loopback endpoint. The Pi path is its real loopback transport. Both are
 * driven through the same fixture, so the assertions compare platform
 * behaviour — catalogue, results, evidence rows, admission/approval/replay
 * refusals — rather than two copies of the same code.
 */

const HARNESS_DIR = path.join(process.cwd(), "src", "server", "harness");
const MCP_SERVER = path.join(HARNESS_DIR, "opencode-mcp-server.mjs");
const PLUGIN = path.join(HARNESS_DIR, "opencode-evidence-plugin.mjs");

const endpoints: OpenCodeToolEndpoint[] = [];
const piBridges: Array<Awaited<ReturnType<typeof createPiBridge>>> = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(endpoints.splice(0).map(endpoint => endpoint.close()));
  await Promise.all(piBridges.splice(0).map(bridge => bridge.close()));
  vi.restoreAllMocks();
});
beforeEach(() => { mocks.evidence.length = 0; });

interface Fixture {
  agent: ReturnType<typeof createAgent>;
  conversation: ReturnType<typeof createConversation>;
  workspace: NonNullable<ReturnType<typeof getWorkspaceForConversation>>;
  openCodeRunId: string;
  piRunId: string;
  taskExecution: TaskExecutionIdentity;
}

let fixtureCount = 0;
function fixture(): Fixture {
  const agent = createAgent({ name: `OpenCode transport ${++fixtureCount}`, adapterName: "opencode", modelId: "fixture", toolNames: [] });
  const conversation = createConversation({ mode: "single", agentIds: [agent.id] });
  const workspace = getWorkspaceForConversation(conversation.id)!;
  return {
    agent,
    conversation,
    workspace,
    openCodeRunId: newRunId(),
    piRunId: newRunId(),
    taskExecution: {
      conductorRunId: "fixture-conductor", planId: "fixture-plan", planRevision: 0,
      taskId: "fixture-task", attemptId: "fixture-attempt", attempt: 1, contextSnapshotId: "fixture-snapshot",
    },
  };
}

function invocation(f: Fixture, toolNames: string[]): HarnessInvocationInput {
  return {
    conversationId: f.conversation.id,
    runId: f.openCodeRunId,
    parentRunId: null,
    taskExecution: f.taskExecution,
    taskContract: null,
    agent: f.agent,
    conversation: f.conversation,
    workspace: f.workspace,
    triggerMessage: {
      id: "msg_fixture", conversationId: f.conversation.id, role: "user", origin: "human", agentId: null,
      runId: null, parts: [{ type: "text", content: "fixture" }], status: "complete", mentionedAgentIds: [],
      parentMessageId: null, createdAt: 1, updatedAt: 2,
    },
    context: { systemPrompt: "fixture", packet: { task: "fixture", priorHistory: [], attachments: [] }, recentMessages: [] },
    tools: { names: toolNames, required: toolNames },
    requirements: {},
    provider: {
      providerId: "deepseek", catalogProvider: "deepseek", modelId: "fixture", endpoint: "https://example.com/v1",
      credential: "fixture", revision: "fixture:1", reasoningEffort: null, vision: false, contextWindow: null,
    },
    workspaceRoot: f.workspace.rootPath,
    access: "workspace",
  };
}

async function openCode(f: Fixture, toolNames: string[]): Promise<{ endpoint: OpenCodeToolEndpoint; post: (route: string, body: unknown) => Promise<Response> }> {
  const endpoint = await createOpenCodeToolEndpoint(
    invocation(f, toolNames),
    new AbortController().signal,
    null,
    { mcpServerPath: MCP_SERVER, pluginPath: PLUGIN },
  );
  endpoints.push(endpoint);
  const post = (route: string, body: unknown) => fetch(`${endpoint.pluginEnvironment.AGENTMELD_OPENCODE_BRIDGE_URL}${route}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${endpoint.pluginEnvironment.AGENTMELD_OPENCODE_BRIDGE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { endpoint, post };
}

async function pi(f: Fixture, toolNames: string[]): Promise<{ bridge: Awaited<ReturnType<typeof createPiBridge>>; post: (route: string, body: unknown) => Promise<Response> }> {
  const bridge = await createPiBridge({
    agent: f.agent,
    conversationId: f.conversation.id,
    runId: f.piRunId,
    workspacePath: f.workspace.rootPath,
    taskExecution: f.taskExecution,
    taskContract: null,
    toolNames,
    systemPrompt: "OpenCode transport parity fixture",
  } as never, new AbortController().signal, () => {});
  piBridges.push(bridge);
  const post = (route: string, body: unknown) => fetch(`${bridge.url}${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { bridge, post };
}

/** A real MCP client over the shim's stdio, exactly like OpenCode's. */
function mcpClient(endpoint: OpenCodeToolEndpoint): {
  child: ChildProcessWithoutNullStreams;
  request: (method: string, params?: unknown) => Promise<Record<string, unknown>>;
  notify: (method: string) => void;
} {
  const child = spawn(process.execPath, [MCP_SERVER], {
    stdio: "pipe",
    env: { ...process.env, ...endpoint.pluginEnvironment },
  });
  children.push(child);
  const lines = readline.createInterface({ input: child.stdout });
  const waiters = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  lines.on("line", line => {
    const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
    if (message.id === undefined) return;
    const waiter = waiters.get(message.id);
    if (!waiter) return;
    waiters.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? "MCP error"));
    else waiter.resolve(message.result as Record<string, unknown>);
  });
  let nextId = 0;
  return {
    child,
    request(method, params) {
      const id = ++nextId;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise((resolve, reject) => {
        waiters.set(id, { resolve: resolve as (value: Record<string, unknown>) => void, reject });
      });
    },
    notify(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
  };
}

/** The fields that identify an evidence row's meaning (ids/timestamps excluded). */
function evidenceRows(runId: string) {
  return mocks.evidence
    .filter(record => record.childRunId === runId)
    .map(record => ({
      type: record.type, status: record.status, trustLevel: record.trustLevel,
      subjectType: record.subjectType, subjectId: record.subjectId,
      // Artifact ids are newly generated per call; compare their presence, not
      // the value, so the two transports are comparable.
      payloadJson: record.payloadJson.replace(/"artifactId":"[^"]+"/g, '"artifactId":"<id>"'),
      contentHash: record.contentHash,
    }));
}

describe("OpenCode tool transport", () => {
  it("advertises exactly the bridge catalogue that Pi advertises", async () => {
    const f = fixture();
    const toolNames = ["fs_read", "read_artifact", "write_artifact", "list_team_members"];
    const { endpoint } = await openCode(f, toolNames);
    const { bridge } = await pi(f, toolNames);
    const client = mcpClient(endpoint);

    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.serverInfo).toMatchObject({ name: "agentmeld" });
    client.notify("notifications/initialized");
    const list = (await client.request("tools/list")) as { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
    expect(list.tools.map(tool => tool.name)).toEqual([
      "read_artifact", "write_artifact", "list_team_members",
    ]);
    expect(list.tools).toEqual(endpoint.bridge.catalogue.map(definition => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.parameters,
    })));
    expect(endpoint.bridge.catalogue.map(tool => tool.name)).toEqual(bridge.businessNames);
    expect(endpoint.nativeTools).toEqual(["fs_read"]);
    expect(bridge.native.map(name => PI_NATIVE_TO_PLATFORM[name])).toEqual(endpoint.nativeTools);
    // One shared catalogue: the MCP server adds no tool of its own.
    endpoint.bridge.catalogue.forEach(definition => {
      expect(endpoint.businessTools).toContain(definition.name);
    });
  });

  it("gives the same business result and evidence row as Pi", async () => {
    const f = fixture();
    const toolNames = ["read_artifact"];
    const { endpoint } = await openCode(f, toolNames);
    const { post } = await pi(f, toolNames);
    const client = mcpClient(endpoint);
    await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    client.notify("notifications/initialized");

    const piResponse = await post("/tool", { callId: "call_read", name: "read_artifact", args: { artifactId: "art_missing" } });
    expect(piResponse.status).toBe(200);
    const piResult = await piResponse.json();

    const result = await client.request("tools/call", { name: "read_artifact", arguments: { artifactId: "art_missing" } }) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Artifact "art_missing" not found.');

    // A failing platform tool is a tool error for both engines, and both paths
    // wrote the same observation + rejection rows.
    expect(piResult).toEqual({ ok: false, error: 'Artifact "art_missing" not found.' });
    const piEvidence = evidenceRows(f.piRunId);
    expect(piEvidence).toHaveLength(2);
    expect(piEvidence[0]).toMatchObject({ type: "artifact_read", status: "invalid", subjectId: "art_missing" });
    expect(piEvidence[1]).toMatchObject({ type: "tool_rejected", status: "invalid", subjectId: "read_artifact" });
    expect(evidenceRows(f.openCodeRunId)).toEqual(piEvidence);
  });

  it("gives the same successful artifact result and evidence as Pi", async () => {
    const f = fixture();
    const toolNames = ["write_artifact"];
    const { endpoint } = await openCode(f, toolNames);
    const { post } = await pi(f, toolNames);
    const client = mcpClient(endpoint);
    await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    client.notify("notifications/initialized");

    const args = { type: "document", title: "Parity note", content: "# parity", outputKey: "note" };
    const piResponse = await post("/tool", { callId: "call_artifact", name: "write_artifact", args });
    expect(piResponse.status).toBe(200);
    const piResult = await piResponse.json() as { ok: boolean; value: Record<string, unknown> };

    const raw = await client.request("tools/call", { name: "write_artifact", arguments: args }) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(raw.isError).toBe(false);
    // Both transports hand the model the same JSON: the platform result value.
    const openCodeValue = JSON.parse(raw.content[0].text) as Record<string, unknown>;
    expect(openCodeValue).toMatchObject({ title: "Parity note", type: "document", outputKey: "note", bindingMode: "replace" });
    expect(piResult).toMatchObject({ ok: true, value: { title: "Parity note", type: "document" } });
    // Artifact ids are generated per call; compare the rest of the value.
    delete openCodeValue.artifactId;
    delete piResult.value.artifactId;
    expect(openCodeValue).toEqual(piResult.value);
    expect(evidenceRows(f.openCodeRunId)).toEqual(evidenceRows(f.piRunId));
    expect(evidenceRows(f.piRunId)[0]).toMatchObject({ type: "artifact_created", status: "valid", subjectType: "artifact" });
  });

  it("keeps the same refusals: unprovisioned, replayed and after a terminal report", async () => {
    const f = fixture();
    const toolNames = ["report_task_result", "read_artifact", "fs_write"];
    const { endpoint, post } = await openCode(f, toolNames);
    const piFixture = await pi(f, toolNames);

    // Unprovisioned business tool over the MCP transport.
    expect((await piFixture.post("/tool", { callId: "unprovisioned", name: "deploy_workspace", args: {} })).status).toBe(403);
    const client = mcpClient(endpoint);
    await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    client.notify("notifications/initialized");
    const refused = await client.request("tools/call", { name: "deploy_workspace", arguments: {} }) as {
      content: Array<{ text: string }>; isError: boolean;
    };
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toBe("Tool is not authorized for this invocation.");

    // Replay: the same call id is refused exactly as on Pi's route.
    expect((await post("/tool", { callId: "replay", name: "read_artifact", args: { artifactId: "x" } })).status).toBe(200);
    const replay = await post("/tool", { callId: "replay", name: "read_artifact", args: { artifactId: "x" } });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ ok: false, error: "Tool call ID has already been consumed." });
    expect((await piFixture.post("/tool", { callId: "replay", name: "read_artifact", args: { artifactId: "x" } })).status).toBe(200);
    const piReplay = await piFixture.post("/tool", { callId: "replay", name: "read_artifact", args: { artifactId: "x" } });
    expect(piReplay.status).toBe(400);
    expect(await piReplay.json()).toMatchObject({ ok: false, error: "Tool call ID has already been consumed." });

    // A terminal report ends native activity on both transports.
    expect((await post("/tool", { callId: "report", name: "report_task_result", args: { status: "complete", summary: "Fixture", acceptanceResults: [] } })).status).toBe(200);
    expect((await piFixture.post("/tool", { callId: "report", name: "report_task_result", args: { status: "complete", summary: "Fixture", acceptanceResults: [] } })).status).toBe(200);
    const late = await post("/native/authorize", { callId: "late-native", name: "fs_write", args: { filePath: "late.txt" }, targetPath: "late.txt" });
    expect(late.status).toBe(400);
    expect(await late.json()).toMatchObject({ error: "This invocation already submitted its terminal platform result." });
    const piLate = await piFixture.post("/native/authorize", { callId: "late-native", name: "write", args: { path: "late.txt" } });
    expect(piLate.status).toBe(400);
    expect(await piLate.json()).toMatchObject({ error: "This invocation already submitted its terminal platform result." });
  });

  it("admits a native write before execution and lands the same evidence as Pi", async () => {
    const f = fixture();
    const toolNames = ["fs_write"];
    const { endpoint, post } = await openCode(f, toolNames);
    const piFixture = await pi(f, toolNames);
    const openCodeTarget = path.join(f.workspace.rootPath, "opencode-shared.txt");
    const piTarget = path.join(f.workspace.rootPath, "pi-shared.txt");

    // OpenCode path: the plugin forwards the proposed change; the driver
    // completes the outcome from the event stream.
    const authorization = await post("/native/authorize", {
      callId: "opencode-native",
      name: "fs_write",
      args: { filePath: openCodeTarget, content: "hello" },
      targetPath: openCodeTarget,
      change: { path: openCodeTarget, content: "hello" },
    });
    expect(authorization.status).toBe(200);
    expect(fs.existsSync(openCodeTarget)).toBe(false);
    fs.writeFileSync(openCodeTarget, "hello");
    const openCodeResult = await endpoint.bridge.completeNative("opencode-native", { text: "wrote opencode-shared.txt", isError: false });

    // Pi path: its extension authorizes, writes and reports the same way.
    expect((await piFixture.post("/native/authorize", { callId: "pi-native", name: "write", args: { path: "pi-shared.txt", content: "hello" } })).status).toBe(200);
    expect((await piFixture.post("/native/change", { callId: "pi-native", path: piTarget, content: "hello" })).status).toBe(200);
    fs.writeFileSync(piTarget, "hello");
    expect((await piFixture.post("/native/result", { callId: "pi-native", result: { content: [{ type: "text", text: "wrote pi-shared.txt" }] }, isError: false })).status).toBe(200);

    expect(openCodeResult.ok).toBe(true);
    const openCodeValue = (openCodeResult as { value: Record<string, unknown> }).value;
    const piValue = (piFixture.bridge.result("pi-native") as { value: Record<string, unknown> }).value;
    expect(openCodeValue).toMatchObject({ path: "opencode-shared.txt", bytes: 5, applied: "opencode-native" });
    expect(piValue).toMatchObject({ path: "pi-shared.txt", bytes: 5, applied: "pi-native" });
    expect(openCodeValue.contentHash).toBe(piValue.contentHash);

    const openCodeEvidence = evidenceRows(f.openCodeRunId);
    const piEvidence = evidenceRows(f.piRunId);
    expect(openCodeEvidence).toHaveLength(1);
    expect(openCodeEvidence[0]).toMatchObject({ type: "file_written", status: "valid", subjectId: "opencode-shared.txt" });
    expect(piEvidence[0]).toMatchObject({ type: "file_written", status: "valid", subjectId: "pi-shared.txt" });
    expect(JSON.parse(openCodeEvidence[0].payloadJson)).toMatchObject({ path: "opencode-shared.txt", action: "created" });
    expect(JSON.parse(piEvidence[0].payloadJson)).toMatchObject({ path: "pi-shared.txt", action: "created" });
  });

  it("refuses an unprovisioned native tool over the plugin route", async () => {
    const f = fixture();
    const { post } = await openCode(f, ["fs_read"]);
    const refused = await post("/native/authorize", {
      callId: "not-provisioned",
      name: "bash",
      args: { command: "echo hi" },
      command: "echo hi",
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ ok: false, error: expect.stringContaining("not provisioned") });
  });

  it("revokes the token and releases the listener when the run ends", async () => {
    const f = fixture();
    const { endpoint } = await openCode(f, ["read_artifact"]);
    const url = endpoint.pluginEnvironment.AGENTMELD_OPENCODE_BRIDGE_URL;
    const token = endpoint.pluginEnvironment.AGENTMELD_OPENCODE_BRIDGE_TOKEN;
    await endpoint.close();
    const after = await fetch(`${url}/manifest`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    expect(after).toBeNull();
  });

  it("fails closed when OpenCode never exposes the business tools", async () => {
    const f = fixture();
    const { endpoint } = await openCode(f, ["read_artifact"]);
    await expect(endpoint.awaitMcpReady(50, new AbortController().signal)).rejects.toMatchObject({
      category: "extension_unavailable",
    });
  });

  it("resolves a readiness wait that started before the transport reported", async () => {
    const f = fixture();
    const { endpoint, post } = await openCode(f, ["read_artifact"]);
    // OpenCode resolves both transports after the prompt is enqueued: the MCP
    // server reports when OpenCode first lists its tools, and the plugin reports
    // when OpenCode bootstraps the session. A waiter must be woken by the report
    // rather than checking the flag once when the wait begins.
    const mcpWait = endpoint.awaitMcpReady(5_000, new AbortController().signal);
    const pluginWait = endpoint.awaitPluginReady(5_000, new AbortController().signal);
    expect((await post("/ready", { kind: "mcp" })).status).toBe(200);
    expect((await post("/ready", { kind: "plugin" })).status).toBe(200);
    await expect(mcpWait).resolves.toBeUndefined();
    await expect(pluginWait).resolves.toBeUndefined();
  });

  it("rejects a readiness wait when the run is cancelled", async () => {
    const f = fixture();
    const { endpoint } = await openCode(f, ["read_artifact"]);
    const controller = new AbortController();
    const wait = endpoint.awaitMcpReady(10_000, controller.signal);
    controller.abort();
    await expect(wait).rejects.toMatchObject({ category: "aborted" });
  });

  it("exits the MCP server when its stdin closes (no orphan process)", async () => {
    const f = fixture();
    const { endpoint } = await openCode(f, ["read_artifact"]);
    const client = mcpClient(endpoint);
    await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const exited = new Promise<number | null>(resolve => client.child.once("exit", code => resolve(code)));
    client.child.stdin.end();
    expect(await exited).toBe(0);
  });
});

describe("OpenCode tool naming", () => {
  it("strips the MCP server prefix to keep platform names neutral", () => {
    expect(`${OPENCODE_TOOL_PREFIX}write_artifact`).toBe("agentmeld_write_artifact");
  });
});
