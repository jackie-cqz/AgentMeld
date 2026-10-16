import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent, updateAgent } from "@/server/agent-service";
import { createConversation, patchConversation } from "@/server/conversation-service";
import { createMessage, createRun, getWorkspaceForConversation, getRun, listMessages, updateRunStatus } from "@/server/repositories";
import { listConsultations } from "@/server/collaboration/consultations";
import { newMessageId, newRunId } from "@/shared/ids";
import { runPiInvocation } from "./runtime";
import { getPiDoctor } from "./config";
import { getDatabase } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { startAgentRun, abortRun } from "@/server/agent-runner";
import { approvePlan } from "@/server/dispatch-plan-manager";
import { SYSTEM_RESOLVED_BY } from "@/server/repositories";
import type { PiInvocationInput } from "./types";
import type { StreamEvent } from "@/shared/types";
import { setTimeout as delay } from "node:timers/promises";

const servers: http.Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function modelServer(responder: (request: Record<string, unknown>, response: http.ServerResponse) => void) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    responder(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>, response);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server failed to bind.");
  return `http://127.0.0.1:${address.port}/v1`;
}

function complete(response: http.ServerResponse, delta: object, finishReason = "stop") {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const chunk of [{ choices: [{ index: 0, delta }] }, { choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }]) {
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", ...chunk })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function invocation(baseUrl: string, toolNames: string[] = []): PiInvocationInput {
  const agent = createAgent({ name: "Pi runtime fixture", adapterName: "pi", modelProvider: "openai-compatible", modelId: "fixture-model",
    apiKey: "fixture-credential-not-real", apiBaseUrl: baseUrl, toolNames, description: "Fixture" });
  const conversation = createConversation({ mode: "single", agentIds: [agent.id], fsWriteApprovalMode: "auto" });
  const triggerMessage = createMessage({ id: newMessageId(), conversationId: conversation.id, role: "user", origin: "human", agentId: null, runId: null,
    parts: [{ type: "text", content: "Execute the supplied fixture task." }], status: "complete", now: Date.now() });
  const workspace = getWorkspaceForConversation(conversation.id)!;
  return { agent, conversation, triggerMessage, workspace, workspacePath: workspace.rootPath,
    conversationId: conversation.id, runId: newRunId(), recentMessages: [], apiKey: agent.apiKey, apiBaseUrl: baseUrl,
    systemPrompt: "You are an AgentMeld test fixture.", toolNames };
}

describe("pinned real Pi process with deterministic model fixtures", () => {
  it("runs a real Pi peer consultation while the source holds the workspace writer lease", async () => {
    let peerId = "";
    let sourceTurns = 0;
    let peerTurns = 0;
    let peerSawWriterLease = false;
    const url = await modelServer((request, response) => {
      if (request.model === "fixture-peer") {
        peerTurns++;
        const tools = request.tools as Array<{ function: { name: string } }>;
        expect(tools.map(tool => tool.function.name)).toEqual(["respond_to_consultation"]);
        peerSawWriterLease = Number((getDatabase().prepare("SELECT COUNT(*) AS n FROM harness_workspace_leases").get() as { n: number }).n) === 1;
        complete(response, { tool_calls: [{ index: 0, id: "peer-opinion", type: "function", function: {
          name: "respond_to_consultation", arguments: JSON.stringify({ status: "replied", answer: "Choose the compact sidebar; no files were modified." }),
        } }] }, "tool_calls");
      } else if (++sourceTurns === 1) {
        complete(response, { tool_calls: [{ index: 0, id: "consult-peer", type: "function", function: {
          name: "consult_agent", arguments: JSON.stringify({ requestKey: "layout-review", targetAgentId: peerId, question: "Please advise on a compact sidebar. Do not change files." }),
        } }] }, "tool_calls");
      } else complete(response, { content: "The peer recommends the compact sidebar. Awaiting your decision." });
    });
    const input = invocation(url, ["consult_agent"]);
    const peer = createAgent({ name: "Pi consultation peer", adapterName: "pi", modelProvider: "openai-compatible", modelId: "fixture-peer",
      apiKey: "fixture-not-a-real-credential", apiBaseUrl: url, toolNames: [], description: "Read-only design consultation" });
    peerId = peer.id;
    input.conversation = patchConversation(input.conversationId, { mode: "group", agentIds: [input.agent.id, peer.id] })!;
    createRun({ id: input.runId, conversationId: input.conversationId, agentId: input.agent.id,
      triggerMessageId: input.triggerMessage.id, status: "running", now: Date.now() });
    const events: StreamEvent[] = [];
    for await (const event of runPiInvocation(input, new AbortController().signal)) events.push(event);
    expect(sourceTurns).toBe(2);
    expect(peerTurns).toBe(1);
    expect(peerSawWriterLease).toBe(true);
    expect(listConsultations(input.conversationId)).toMatchObject([{ status: "replied", sourceRunId: input.runId, targetAgentId: peer.id }]);
    expect(events.some(event => event.type === "tool.result" && !event.isError)).toBe(true);
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM harness_workspace_leases").get()).toEqual({ n: 0 });
    updateRunStatus(input.runId, "complete", null, Date.now());
  }, process.platform === "win32" ? 120000 : 60000);

  it("loads the pinned CLI and permission extension and commits streamed text", async () => {
    expect(getPiDoctor().available).toBe(true);
    const url = await modelServer((_request, response) => complete(response, { content: "Pi fixture answer" }));
    const input = invocation(url);
    const events: StreamEvent[] = [];
    for await (const event of runPiInvocation(input, new AbortController().signal)) events.push(event);
    expect(events.some(event => event.type === "part.delta" && event.delta.text === "Pi fixture answer")).toBe(true);
  }, process.platform === "win32" ? 75000 : 30000);

  it("lets Pi execute a native write and perform the next model turn", async () => {
    let requests = 0;
    const url = await modelServer((request, response) => {
      requests++;
      const tools = request.tools as Array<{ function: { name: string } }>;
      expect(tools.map(tool => tool.function.name)).toContain("write");
      expect(tools.map(tool => tool.function.name)).not.toContain("fs_write");
      if (requests === 1) complete(response, { tool_calls: [{ index: 0, id: "native-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "hello.txt", content: "Written by real Pi" }) } }] }, "tool_calls");
      else complete(response, { content: "Native write completed" });
    });
    const input = invocation(url, ["fs_write"]);
    const events: StreamEvent[] = [];
    for await (const event of runPiInvocation(input, new AbortController().signal)) events.push(event);
    expect(events.filter(event => event.type === "tool.result" && event.isError)).toEqual([]);
    expect(fs.readFileSync(path.join(input.workspacePath, "hello.txt"), "utf8")).toBe("Written by real Pi");
    expect(requests).toBe(2);
    expect(events.some(event => event.type === "tool.result" && !event.isError)).toBe(true);
  }, 30000);

  it("authorizes native writes when the workspace is reached through a directory alias", async () => {
    let requests = 0;
    let nativePath = "";
    const url = await modelServer((_request, response) => {
      requests++;
      complete(response, requests === 1 ? { tool_calls: [{ index: 0, id: "alias-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: nativePath, content: "same physical workspace" }) } }] } : { content: "Done" }, requests === 1 ? "tool_calls" : "stop");
    });
    const input = invocation(url, ["fs_write"]);
    const target = input.workspacePath;
    nativePath = path.join(fs.realpathSync.native(target), "alias.txt");
    const alias = `${target}-alias`;
    fs.symlinkSync(target, alias, "junction");
    input.workspacePath = alias;
    const events: StreamEvent[] = [];
    for await (const event of runPiInvocation(input, new AbortController().signal)) events.push(event);
    expect(events.filter(event => event.type === "tool.result" && event.isError)).toEqual([]);
    expect(fs.readFileSync(path.join(target, "alias.txt"), "utf8")).toBe("same physical workspace");
  }, 30000);

  it.skipIf(process.platform !== "win32")("resolves Windows short workspace paths for native relative writes", async ({ skip }) => {
    let requests = 0;
    const url = await modelServer((_request, response) => {
      requests++;
      complete(response, requests === 1 ? { tool_calls: [{ index: 0, id: "short-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "short.txt", content: "short-path write" }) } }] } : { content: "Done" }, requests === 1 ? "tool_calls" : "stop");
    });
    const input = invocation(url, ["fs_write"]);
    const shortPath = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:FIXTURE_WORKSPACE).ShortPath"], { env: { ...process.env, FIXTURE_WORKSPACE: input.workspacePath }, encoding: "utf8", windowsHide: true }).trim();
    if (shortPath.toLowerCase() === fs.realpathSync.native(input.workspacePath).toLowerCase()) skip();
    input.workspacePath = shortPath;
    const events: StreamEvent[] = [];
    for await (const event of runPiInvocation(input, new AbortController().signal)) events.push(event);
    expect(events.filter(event => event.type === "tool.result" && event.isError)).toEqual([]);
    expect(fs.readFileSync(path.join(input.workspacePath, "short.txt"), "utf8")).toBe("short-path write");
  }, 30000);

  it("uses Pi's batch edit algorithm and preserves BOM and CRLF bytes", async () => {
    let requests = 0;
    const url = await modelServer((_request, response) => {
      if (++requests === 1) complete(response, { tool_calls: [{ index: 0, id: "native-edit", type: "function", function: { name: "edit", arguments: JSON.stringify({ path: "existing.txt", edits: [{ oldText: "old", newText: "new" }] }) } }] }, "tool_calls");
      else complete(response, { content: "Edited" });
    });
    const input = invocation(url, ["fs_patch"]);
    fs.writeFileSync(path.join(input.workspacePath, "existing.txt"), "\ufeffold\r\nunchanged\r\n");
    const events: StreamEvent[] = [];
    for await (const event of runPiInvocation(input, new AbortController().signal)) events.push(event);
    expect(events.filter(event => event.type === "tool.result" && event.isError)).toEqual([]);
    expect(fs.readFileSync(path.join(input.workspacePath, "existing.txt"), "utf8")).toBe("\ufeffnew\r\nunchanged\r\n");
    expect(events.some(event => event.type === "tool.result" && !event.isError)).toBe(true);
  }, 30000);

  it("records a model HTTP error as failure without inventing zero usage", async () => {
    const url = await modelServer((_request, response) => { response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "fixture rejected request" } })); });
    const input = invocation(url);
    await expect(async () => { for await (const event of runPiInvocation(input, new AbortController().signal)) void event; }).rejects.toMatchObject({ category: "provider" });
    expect(getDatabase().prepare("SELECT status,error_category,usage_json FROM harness_executions WHERE run_id=?").get(input.runId)).toEqual({ status: "failed", error_category: "provider", usage_json: null });
  }, 30000);

  it("does not mark truncated output complete", async () => {
    const url = await modelServer((_request, response) => complete(response, { content: "unfinished" }, "length"));
    await expect(async () => { for await (const event of runPiInvocation(invocation(url), new AbortController().signal)) void event; }).rejects.toMatchObject({ category: "output_limit" });
  }, 30000);

  it("fails explicitly when the invocation deadline expires", async () => {
    vi.stubEnv("AGENTMELD_PI_RUN_TIMEOUT_MS", "2000");
    const url = await modelServer(() => {});
    const input = invocation(url);
    await expect(async () => { for await (const event of runPiInvocation(input, new AbortController().signal)) void event; }).rejects.toMatchObject({ category: "timeout" });
    expect(getDatabase().prepare("SELECT status,error_category FROM harness_executions WHERE run_id=?").get(input.runId)).toEqual({ status: "failed", error_category: "timeout" });
  }, 30000);

  it("cancels a pending model request and releases the workspace only after exit", async () => {
    let requested!: () => void;
    const started = new Promise<void>(resolve => { requested = resolve; });
    const url = await modelServer(() => { requested(); });
    const input = invocation(url);
    const controller = new AbortController();
    const pending = (async () => { for await (const event of runPiInvocation(input, controller.signal)) void event; })();
    const rejected = expect(pending).rejects.toMatchObject({ category: "aborted" });
    await started;
    controller.abort();
    await rejected;
    expect(getDatabase().prepare("SELECT status FROM harness_executions WHERE run_id=?").get(input.runId)).toEqual({ status: "aborted" });
    expect(getDatabase().prepare("SELECT COUNT(*) AS count FROM harness_workspace_leases").get()).toEqual({ count: 0 });
  }, 30000);

  it("cancels native approval before files or directories are created", async () => {
    const url = await modelServer((_request, response) => complete(response, { tool_calls: [{ index: 0, id: "approval-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "new-dir/file.txt", content: "must not be written" }) } }] }, "tool_calls"));
    const input = invocation(url, ["fs_write"]);
    getDatabase().prepare("UPDATE conversations SET fs_write_approval_mode='review' WHERE id=?").run(input.conversationId);
    const controller = new AbortController();
    const unsubscribe = eventBus.subscribe(entry => { if (entry.event.type === "fs_write.pending" && entry.event.pendingWrite.runId === input.runId) controller.abort(); });
    try {
      await expect(async () => { for await (const event of runPiInvocation(input, controller.signal)) void event; }).rejects.toMatchObject({ category: "aborted" });
      expect(fs.existsSync(path.join(input.workspacePath, "new-dir"))).toBe(false);
    } finally { unsubscribe(); }
  }, 30000);

  it("stops an active native verification process before releasing ownership", async () => {
    const url = await modelServer((_request, response) => complete(response, { tool_calls: [{ index: 0, id: "long-test", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "npm run test", timeout: 120 }) } }] }, "tool_calls"));
    const input = invocation(url, ["bash"]);
    fs.writeFileSync(path.join(input.workspacePath, "package.json"), JSON.stringify({ scripts: { test: "node long-test.cjs" } }));
    fs.writeFileSync(path.join(input.workspacePath, "long-test.cjs"), 'require("node:fs").writeFileSync("test.pid",String(process.pid));setInterval(()=>{},1000);');
    const controller = new AbortController();
    let nativeError = "";
    const pending = (async () => { for await (const event of runPiInvocation(input, controller.signal)) {
      if (event.type === "tool.result" && event.isError) nativeError = String(event.result);
    } })();
    const outcome = pending.then(() => null, error => error);
    let pid: number | undefined;
    try {
      for (let n = 0; n < 100 && !nativeError && !fs.existsSync(path.join(input.workspacePath, "test.pid")); n++) await delay(100);
      expect(fs.existsSync(path.join(input.workspacePath, "test.pid")), nativeError || "verification script started").toBe(true);
      pid = Number(fs.readFileSync(path.join(input.workspacePath, "test.pid"), "utf8"));
      controller.abort();
      expect(await outcome).toMatchObject({ category: "aborted" });
      expect(() => process.kill(pid!, 0)).toThrow();
      expect(getDatabase().prepare("SELECT COUNT(*) AS count FROM harness_workspace_leases").get()).toEqual({ count: 0 });
    } finally {
      controller.abort();
      await pending.catch(() => {});
      if (pid) { try { process.kill(pid); } catch { /* Already stopped. */ } }
    }
  }, 30000);

  it("runs Conductor planning, two dependent Agents and aggregation through isolated Pi sessions", async () => {
    const turns = new Map<string, number>();
    let producerId = "";
    let reviewerId = "";
    let conversationId = "";
    const callTool = (response: http.ServerResponse, name: string, args: object, id: string) => complete(response, { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
    const url = await modelServer((request, response) => {
      const tools = (request.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name);
      const messages = JSON.stringify(request.messages);
      if (tools.includes("plan_tasks")) {
        callTool(response, "plan_tasks", { reasoning: "Deliver a document, then a dependent audit.", tasks: [
          { id: "produce", agentId: producerId, title: "Fixture document", prompt: "Write the requested document.", expectedOutputs: [{ id: "fixture_doc", type: "document", required: true }] },
          { id: "audit", agentId: reviewerId, title: "Fixture audit", prompt: "Read the upstream document and write an audit.", dependsOn: ["produce"], inputs: [{ fromTaskId: "produce", outputId: "fixture_doc", required: true }], expectedOutputs: [{ id: "fixture_audit", type: "document", required: true }] },
        ] }, "fixture-plan");
      } else if (tools.includes("report_task_result")) {
        const review = messages.includes("PI_FIXTURE_AUDITOR");
        const stage = review ? "audit" : "produce";
        const count = (turns.get(stage) ?? 0) + 1;
        turns.set(stage, count);
        if (review && count === 1) {
          const artifact = getDatabase().prepare("SELECT id FROM artifacts WHERE conversation_id=? AND created_by_agent_id=? ORDER BY created_at DESC LIMIT 1").get(conversationId, producerId) as { id: string };
          expect(messages).toContain(artifact.id);
          callTool(response, "read_artifact", { artifactId: artifact.id }, "fixture-read");
        } else if (count === (review ? 2 : 1)) {
          callTool(response, "write_artifact", { type: "document", title: stage, content: `# ${stage}\n\nA complete deterministic fixture deliverable.`, outputKey: review ? "fixture_audit" : "fixture_doc" }, `fixture-write-${stage}`);
        } else callTool(response, "report_task_result", { status: "complete", summary: `${stage} completed with a stored artifact.`, acceptanceResults: [] }, `fixture-report-${stage}`);
      } else complete(response, { content: "PIPELINE_COMPLETE" });
    });
    const makeAgent = (name: string, marker: string) => createAgent({ name, systemPrompt: marker, adapterName: "pi", modelProvider: "openai-compatible", modelId: "fixture-model", apiKey: "fixture-key", apiBaseUrl: url, toolNames: ["write_artifact", "read_artifact"] });
    producerId = makeAgent("Document specialist", "PI_FIXTURE_PRODUCER").id;
    reviewerId = makeAgent("Audit specialist", "PI_FIXTURE_AUDITOR").id;
    updateAgent("ag_mock_conductor", { modelProvider: "openai-compatible", modelId: "fixture-model", apiKey: "fixture-key", apiBaseUrl: url, toolNames: ["plan_tasks", "read_artifact"] });
    const conversation = createConversation({ mode: "group", agentIds: ["ag_mock_conductor", producerId, reviewerId] });
    conversationId = conversation.id;
    const triggerMessage = createMessage({ id: newMessageId(), conversationId, role: "user", origin: "human", parts: [{ type: "text", content: "Create the fixture document and then audit it." }], status: "complete", now: Date.now() });
    const ends: StreamEvent[] = [];
    const unsubscribe = eventBus.subscribe(({ event }) => {
      if (event.type === "dispatch.plan.pending" && event.conversationId === conversationId) approvePlan(event.pendingPlan.id, undefined, SYSTEM_RESOLVED_BY);
      if (event.type === "run.end" && event.conversationId === conversationId) ends.push(event);
    });
    const handle = startAgentRun({ conversationId, agentId: "ag_mock_conductor", triggerMessage });
    const timeout = setTimeout(() => abortRun(handle.runId), 40000);
    try {
      await handle.promise;
      expect(getRun(handle.runId)?.status).toBe("complete");
      expect(getDatabase().prepare("SELECT task_id,status FROM conductor_task_results WHERE conductor_run_id=? ORDER BY task_id").all(handle.runId)).toEqual([{ task_id: "audit", status: "complete" }, { task_id: "produce", status: "complete" }]);
      const executions = getDatabase().prepare("SELECT native_session_id,status FROM harness_executions WHERE run_id IN (SELECT id FROM agent_runs WHERE id=? OR parent_run_id=?)").all(handle.runId, handle.runId) as Array<{ native_session_id: string; status: string }>;
      expect(executions).toHaveLength(4);
      expect(executions.every(execution => execution.status === "complete")).toBe(true);
      expect(new Set(executions.map(execution => execution.native_session_id)).size).toBe(4);
      expect(ends).toHaveLength(3);
      expect(listMessages(conversationId).some(message => message.parts.some(part => part.type === "text" && part.content.includes("PIPELINE_COMPLETE")))).toBe(true);
    } finally { clearTimeout(timeout); unsubscribe(); }
  }, 60000);
});
