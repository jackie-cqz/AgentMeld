import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent, updateAgent } from "@/server/agent-service";
import { createConversation, patchConversation, sendMessage } from "@/server/conversation-service";
import { createMessage, createRun, getWorkspaceForConversation, getRun, listMessages, updateRunStatus } from "@/server/repositories";
import { listConsultations } from "@/server/collaboration/consultations";
import { submitPiFollowup, type PiFollowupReceipt } from "./controls";
import { newMessageId, newRunId } from "@/shared/ids";
import { runPiInvocation } from "./runtime";
import { getPiDoctor } from "./config";
import { getDatabase } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { startAgentRun, abortRun, isRunActive } from "@/server/agent-runner";
import { listCollaborationTurns } from "@/server/collaboration/turns";
import { decideHandoff, getHandoff, proposeHandoff } from "@/server/collaboration/handoffs";
import { listTaskAttempts } from "@/server/repositories/evidence-repository";
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
  it("hands off an active task between real Pi processes only after the original writer has exited", async () => {
    let sourceRequested = false;
    let sourceId = "", targetId = "";
    let targetTurns = 0;
    const taskId = "handoff-inspection";
    const url = await modelServer((request, response) => {
      if (request.model === "fixture-handoff-source") { sourceRequested = true; return; }
      if (request.model === "fixture-handoff-target") {
        if (++targetTurns === 1) complete(response, { tool_calls: [{ index: 0, id: "handoff-report", type: "function", function: { name: "report_task_result",
          arguments: JSON.stringify({ status: "complete", summary: "Completed the bounded inspection after takeover.", acceptanceResults: [], blockers: [], artifacts: {} }) } }] }, "tool_calls");
        else complete(response, { content: "The bounded inspection is complete." });
        return;
      }
      const tools = request.tools as Array<{ function: { name: string } }>;
      if (tools.some(tool => tool.function.name === "plan_tasks")) complete(response, { tool_calls: [{ index: 0, id: "handoff-plan", type: "function", function: { name: "plan_tasks",
        arguments: JSON.stringify({ reasoning: "One explicitly scoped diagnostic task.", tasks: [{ id: taskId, agentId: sourceId, title: "Bounded inspection", prompt: "Inspect the assigned question and report the result.", taskIntent: "diagnosis", contractProfile: "minimal", dependsOn: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 }] }) } }] }, "tool_calls");
      else complete(response, { content: "The teammate completed the handed-off task." });
    });
    const source = createAgent({ name: "Handoff source", adapterName: "pi", modelProvider: "openai-compatible", modelId: "fixture-handoff-source", apiKey: "fixture-key", apiBaseUrl: url, toolNames: [] });
    const target = createAgent({ name: "Handoff target", adapterName: "pi", modelProvider: "openai-compatible", modelId: "fixture-handoff-target", apiKey: "fixture-key", apiBaseUrl: url, toolNames: [] });
    sourceId = source.id; targetId = target.id;
    updateAgent("ag_mock_conductor", { modelProvider: "openai-compatible", modelId: "fixture-handoff-coordinator", apiKey: "fixture-key", apiBaseUrl: url, toolNames: ["plan_tasks", "read_artifact"] });
    const conversation = createConversation({ mode: "group", agentIds: ["ag_mock_conductor", sourceId, targetId] });
    const unsubscribe = eventBus.subscribe(({ event }) => { if (event.type === "dispatch.plan.pending" && event.conversationId === conversation.id) approvePlan(event.pendingPlan.id, undefined, "owner-session:pi-handoff-fixture"); });
    const sent = await sendMessage({ origin: "human", conversationId: conversation.id, content: "Perform one scoped diagnostic task.", action: "new_task" });
    try {
      await vi.waitFor(() => expect(sourceRequested).toBe(true), { timeout: 40000 });
      const original = listTaskAttempts(sent.runIds[0], taskId)[0];
      const owner = { kind: "owner-session" as const, sessionId: "pi-handoff-fixture", createdAt: Date.now() };
      const proposal = await proposeHandoff(original.id, targetId, owner);
      await decideHandoff(proposal.id, "accept", owner);
      await vi.waitFor(() => expect(isRunActive(sent.runIds[0])).toBe(false), { timeout: 60000 });
      expect(getHandoff(proposal.id)?.executionStatus).toBe("complete");
      const attempts = listTaskAttempts(sent.runIds[0], taskId);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toMatchObject({ taskId, attempt: 2, agentId: targetId, verificationStatus: "verified" });
      expect(attempts[0].contextSnapshotId).not.toBe(attempts[1].contextSnapshotId);
      const receipts = getDatabase().prepare("SELECT run_id,started_at,finished_at,status FROM harness_executions WHERE run_id IN (?,?) ORDER BY started_at").all(original.childRunId, attempts[1].childRunId) as Array<{ run_id: string; started_at: number; finished_at: number | null; status: string }>;
      const old = receipts.find(receipt => receipt.run_id === original.childRunId)!;
      const replacement = receipts.find(receipt => receipt.run_id === attempts[1].childRunId)!;
      expect(old.finished_at).not.toBeNull();
      expect(replacement.started_at).toBeGreaterThanOrEqual(old.finished_at!);
      expect(replacement.status).toBe("complete");
      const physical = fs.realpathSync.native(getWorkspaceForConversation(conversation.id)!.rootPath);
      const key = process.platform === "win32" ? path.normalize(physical).toLowerCase() : physical;
      expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM harness_workspace_leases WHERE workspace_key=?").get(key)).toEqual({ n: 0 });
    } finally {
      unsubscribe(); abortRun(sent.runIds[0]);
      await vi.waitFor(() => expect(isRunActive(sent.runIds[0])).toBe(false), { timeout: 30000 });
    }
  }, process.platform === "win32" ? 150000 : 90000);

  it("admits a human group discussion, consults a real Pi peer, and creates no plan or artifact", async () => {
    let peerId = "";
    let sourceTurns = 0;
    let classifierTurns = 0;
    let peerTurns = 0;
    const url = await modelServer((request, response) => {
      const messages = JSON.stringify(request.messages);
      if (messages.includes("AGENTMELD_TURN_CLASSIFIER_V1")) {
        classifierTurns++;
        complete(response, { content: JSON.stringify({ intent: "discussion", targetRunId: null, mode: "discussion", reason: "The user requests opinions, not implementation." }) });
      } else if (request.model === "fixture-group-peer") {
        peerTurns++;
        complete(response, { tool_calls: [{ index: 0, id: "group-peer-response", type: "function", function: { name: "respond_to_consultation",
          arguments: JSON.stringify({ status: "replied", answer: "Use a compact sidebar and keep the content column readable." }) } }] }, "tool_calls");
      } else {
        const tools = ((request.tools ?? []) as Array<{ function: { name: string } }>).map(tool => tool.function.name);
        expect(tools).toEqual(expect.arrayContaining(["consult_agent", "read_artifact"]));
        expect(tools).not.toContain("write"); expect(tools).not.toContain("plan_tasks");
        if (++sourceTurns === 1) complete(response, { tool_calls: [{ index: 0, id: "group-consult", type: "function", function: { name: "consult_agent",
          arguments: JSON.stringify({ requestKey: "group-layout", targetAgentId: peerId, question: "Give a read-only design opinion; do not modify files." }) } }] }, "tool_calls");
        else complete(response, { content: "The team recommends the compact sidebar. No files were modified." });
      }
    });
    const peer = createAgent({ name: "Group designer", adapterName: "pi", modelProvider: "openai-compatible", modelId: "fixture-group-peer", apiKey: "fixture-key", apiBaseUrl: url, toolNames: [], capabilities: ["design"] });
    peerId = peer.id;
    updateAgent("ag_mock_conductor", { modelProvider: "openai-compatible", modelId: "fixture-group-source", apiKey: "fixture-key", apiBaseUrl: url,
      toolNames: ["consult_agent", "read_artifact", "plan_tasks", "fs_write", "bash"] });
    const conversation = createConversation({ mode: "group", agentIds: ["ag_mock_conductor", peer.id] });
    const result = await sendMessage({ origin: "human", conversationId: conversation.id, content: "请和设计师讨论布局，先别改。", clientRequestId: "real-group-discussion" });
    try {
      await vi.waitFor(() => expect(isRunActive(result.runIds[0])).toBe(false), { timeout: 60000 });
      expect(getRun(result.runIds[0])?.status).toBe("complete");
      expect([classifierTurns, sourceTurns, peerTurns]).toEqual([1, 2, 1]);
      expect(listCollaborationTurns(conversation.id)).toMatchObject([{ mode: "discussion", status: "applied" }]);
      expect(listConsultations(conversation.id)).toMatchObject([{ status: "replied" }]);
      expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM conductor_plans WHERE conversation_id=?").get(conversation.id)).toEqual({ n: 0 });
      expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM artifacts WHERE conversation_id=?").get(conversation.id)).toEqual({ n: 0 });
      expect(fs.readdirSync(getWorkspaceForConversation(conversation.id)!.rootPath)).toEqual([]);
    } finally { abortRun(result.runIds[0]); }
  }, process.platform === "win32" ? 120000 : 60000);

  it("persists a human supplement and applies it to the same real Pi discussion without another task invocation", async () => {
    let heldResponse: http.ServerResponse | undefined;
    let requests = 0;
    let nextTurnReceivedSupplement = false;
    const supplementText = "Focus on the second compact layout option.";
    const url = await modelServer((request, response) => {
      if (++requests === 1) heldResponse = response;
      else {
        nextTurnReceivedSupplement = JSON.stringify(request.messages).includes(supplementText);
        complete(response, { content: "The second layout is the more compact option." });
      }
    });
    const agent = createAgent({ name: "Live discussion", adapterName: "pi", modelProvider: "openai-compatible", modelId: "fixture-model", apiKey: "fixture-key", apiBaseUrl: url, toolNames: [] });
    const conversation = createConversation({ mode: "single", agentIds: [agent.id] });
    const original = await sendMessage({ origin: "human", conversationId: conversation.id, content: "Discuss the layout options.", action: "discussion", clientRequestId: "live-original" });
    try {
      await vi.waitFor(() => expect(heldResponse).toBeDefined(), { timeout: 30000 });
      const followup = await sendMessage({ origin: "human", conversationId: conversation.id, content: supplementText,
        action: "supplement", targetRunId: original.runIds[0], clientRequestId: "live-supplement" });
      await vi.waitFor(() => expect(listCollaborationTurns(conversation.id).find(turn => turn.runId === followup.runIds[0])?.status).toBe("queued"));
      complete(heldResponse!, { content: "I have compared both layouts." });
      await vi.waitFor(() => expect(isRunActive(original.runIds[0]) || isRunActive(followup.runIds[0])).toBe(false), { timeout: 30000 });
      expect(nextTurnReceivedSupplement).toBe(true);
      expect(requests).toBe(2);
      expect(listCollaborationTurns(conversation.id).map(turn => turn.status)).toEqual(["applied", "applied"]);
      expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM harness_executions WHERE run_id IN (?,?)").get(original.runIds[0], followup.runIds[0])).toEqual({ n: 1 });
    } finally { abortRun(original.runIds[0]); }
  }, process.platform === "win32" ? 90000 : 45000);

  it.each(["steer", "follow_up"] as const)("confirms real Pi %s consumption separately from the RPC acknowledgement", async kind => {
    let firstResponse: http.ServerResponse | undefined;
    let signalFirst!: () => void;
    const firstRequest = new Promise<void>(resolve => { signalFirst = resolve; });
    let requests = 0;
    let modelReceivedFollowup = false;
    const text = `Discuss the compact layout via ${kind}; do not change files.`;
    const url = await modelServer((request, response) => {
      if (++requests === 1) { firstResponse = response; signalFirst(); }
      else {
        modelReceivedFollowup = JSON.stringify(request.messages).includes(text);
        complete(response, { content: "The updated discussion is complete." });
      }
    });
    const input = invocation(url);
    input.accessMode = "conversation";
    const controller = new AbortController();
    const receipts: PiFollowupReceipt[] = [];
    const pending = (async () => { for await (const event of runPiInvocation(input, controller.signal)) void event; })();
    try {
      await Promise.race([firstRequest, pending.then(() => { throw new Error("Pi ended before requesting the model."); })]);
      const queued = await submitPiFollowup(input.runId, { id: `followup-${kind}`, kind, text }, receipt => receipts.push(receipt));
      expect(queued.state).toBe("queued");
      expect(receipts.map(receipt => receipt.state)).toEqual(["queued"]);
      complete(firstResponse!, { content: "Initial discussion reply." });
      await pending;
      expect(requests).toBe(2);
      expect(modelReceivedFollowup).toBe(true);
      expect(receipts.map(receipt => receipt.state)).toEqual(["queued", "applied"]);
    } finally { controller.abort(); await pending.catch(() => {}); }
  }, process.platform === "win32" ? 75000 : 30000);

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
