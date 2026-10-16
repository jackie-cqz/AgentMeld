import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { toolRegistry } from "@/server/tools/registry";
import type { ToolContext, ToolResult } from "@/server/tools/types";
import type { PiInvocationInput } from "./types";
import { authorizeNativeTool, authorizeNativeChange, captureNativeResult, nativeToolNames, PI_NATIVE_TO_PLATFORM, type NativeAdmission } from "./native-tools";
import { CONVERSATION_ROSTER_TOOL } from "./tool-surface";
import { cancelPendingBashForRun } from "@/server/pending-bash";
import { cancelPendingWritesForRun } from "@/server/pending-writes";
import { cancelPendingQuestionsForRun } from "@/server/pending-questions";
import { cancelPendingPlansForRun } from "@/server/dispatch-plan-manager";
import { recordTaskArtifact } from "@/server/dispatch-task-results";
import { assertPiAccessProfile } from "./access-profile";
import type { PiWorkspaceLease } from "./workspace-lease";

const callSchema = z.object({ callId: z.string().min(1).max(200), name: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()) });
const outcomeSchema = z.object({ callId: z.string().min(1).max(200), result: z.unknown(), isError: z.boolean() });

export function cancelPiApprovals(runId: string): void {
  cancelPendingBashForRun(runId);
  cancelPendingWritesForRun(runId);
  cancelPendingQuestionsForRun(runId);
  cancelPendingPlansForRun(runId);
}

/** A private, invocation-scoped tool bridge. Nothing is registered in the public Next API. */
export async function createPiBridge(input: PiInvocationInput, signal: AbortSignal, onBudgetExceeded: () => void, lease: PiWorkspaceLease | null = null) {
  assertPiAccessProfile(input.accessMode, input.toolNames);
  const maxTurns = input.maxTurns ?? 64;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 64) throw new Error("Invalid Pi turn limit.");
  const token = randomBytes(32).toString("hex");
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const ctx: ToolContext = { conversationId: input.conversationId, agentId: input.agent.id,
    runId: input.runId, parentRunId: input.parentRunId, workspacePath: input.workspacePath,
    taskExecution: input.taskExecution, taskContract: input.taskContract, abortSignal: signal };
  // `input.toolNames` is what this invocation is PROVISIONED with, not a
  // permission decision: an Agent run is provisioned with the full Pi toolset
  // (see tool-surface.ts), while platform-internal phases such as the
  // Conductor's PLAN stage still scope their own surface deliberately.
  const native = nativeToolNames(input.toolNames);
  const businessNames = input.toolNames.filter(name => !Object.values(PI_NATIVE_TO_PLATFORM).includes(name));
  const definitions = toolRegistry.resolve(businessNames).map(tool => ({ name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters) }));
  const results = new Map<string, ToolResult>();
  const admissions = new Map<string, NativeAdmission>();
  const admittedCalls = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  let closed = false;
  let turns = 0;
  let ready = false;
  let terminalToolAccepted = false;
  let consultationActive = false;
  let activeBusinessCalls = 0;
  let activeNativeAdmissions = 0;

  const serve = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const authorization = Buffer.from(request.headers.authorization ?? "");
    if (closed || signal.aborted || authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) {
      response.writeHead(403).end(); return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json");
    const send = (body: unknown, status = 200) => { if (!response.destroyed) response.writeHead(status).end(JSON.stringify(body)); };
    try {
      if (request.method === "GET" && request.url === "/manifest") {
        const systemPrompt = Object.entries(PI_NATIVE_TO_PLATFORM).reduce((prompt, [native, platform]) =>
          native === platform ? prompt : prompt.replace(new RegExp(`\\b${platform}\\b`, "g"), native), input.systemPrompt);
        const rosterGuidance = businessNames.includes(CONVERSATION_ROSTER_TOOL)
          ? `\nBefore consulting or planning, use ${CONVERSATION_ROSTER_TOOL} for the current roster. Use exact member IDs and preserve platform DAG and acceptance requirements.`
          : "";
        send({ definitions, native, systemPrompt: `${systemPrompt}${rosterGuidance}`,
          needsReport: Boolean(input.parentRunId), maxTurns });
        return;
      }
      if (request.method !== "POST") { send({ error: "Unknown bridge operation." }, 404); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 2 * 1024 * 1024) throw new Error("Tool request exceeds its byte limit.");
        chunks.push(buffer);
      }
      signal.throwIfAborted();
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.url === "/ready") { ready = true; send({ ok: true }); return; }
      if (request.url === "/turn") {
        if (++turns > maxTurns) { send({ ok: false, error: "Pi turn budget exhausted." }, 409); onBudgetExceeded(); }
        else send({ ok: true });
        return;
      }
      if (request.url === "/native/result") {
        const value = outcomeSchema.parse(body);
        const admission = admissions.get(value.callId);
        if (!admission) throw new Error("Native result has no matching admitted call.");
        admissions.delete(value.callId);
        const result = await captureNativeResult(admission, value.result, value.isError, value.callId, ctx);
        results.set(value.callId, result);
        send({ ok: true });
        return;
      }
      if (request.url === "/native/change") {
        const change = z.object({ callId: z.string(), path: z.string(), content: z.string() }).parse(body);
        const admission = admissions.get(change.callId);
        if (!admission) throw new Error("Native change has no matching admitted call.");
        await authorizeNativeChange(admission, change.path, change.content, ctx);
        send({ ok: true });
        return;
      }
      const call = callSchema.parse(body);
      if (consultationActive) throw new Error("This invocation is waiting for its peer; tools resume after the peer has stopped.");
      lease?.assertActive();
      if (terminalToolAccepted) throw new Error("This invocation already submitted its terminal platform result.");
      if (admittedCalls.size >= 512) throw new Error("Pi tool call budget exhausted.");
      if (admittedCalls.has(call.callId)) throw new Error("Tool call ID has already been consumed.");
      admittedCalls.add(call.callId);
      if (request.url === "/native/authorize") {
        activeNativeAdmissions++;
        try {
          if (!native.includes(call.name)) throw new Error("Native tool is not provisioned for this internal invocation.");
          admissions.set(call.callId, await authorizeNativeTool(call.name, call.args, ctx));
        }
        catch (error) {
          const result = await toolRegistry.recordPreflightFailure(PI_NATIVE_TO_PLATFORM[call.name] ?? call.name, call.args,
            error instanceof Error ? error.message : "Native tool admission failed.", ctx,
            { callId: call.callId, source: "system" }, { code: "PI_NATIVE_TOOL_REJECTED", category: "security_policy" });
          results.set(call.callId, result);
          throw error;
        } finally { activeNativeAdmissions--; }
        signal.throwIfAborted();
        send({ ok: true });
      } else if (request.url === "/tool" && businessNames.includes(call.name)) {
        let result: ToolResult;
        if (call.name === "consult_agent") {
          if (admissions.size || activeNativeAdmissions || activeBusinessCalls) throw new Error("Finish other tool calls before handing the workspace to a peer.");
          consultationActive = true;
          try {
            const execute = (consultationLease?: PiWorkspaceLease) => toolRegistry.execute(call.name, call.args,
              { ...ctx, consultationLease }, { callId: call.callId, source: "pi" });
            result = lease ? await lease.lend(execute) : await execute();
          } finally { consultationActive = false; }
        } else {
          activeBusinessCalls++;
          try { result = await toolRegistry.execute(call.name, call.args, ctx, { callId: call.callId, source: "pi" }); }
          finally { activeBusinessCalls--; }
        }
        if (result.ok && result.value && typeof result.value === "object") {
          const value = result.value as Record<string, unknown>;
          if (typeof value.artifactId === "string" && typeof value.outputKey === "string") {
            // Bind before Pi can issue report_task_result; stdout projection may lag.
            recordTaskArtifact(input.runId, value.outputKey, value.artifactId);
          }
        }
        results.set(call.callId, result);
        if (result.ok && ["plan_tasks", "report_task_result", "respond_to_consultation"].includes(call.name)) terminalToolAccepted = true;
        send(result);
      } else send({ ok: false, error: "Tool is not authorized for this invocation." }, 403);
    } catch (error) {
      send({ ok: false, error: error instanceof Error ? error.message : "Tool bridge rejected the request." }, 400);
    }
  };
  const server = http.createServer((request, response) => {
    const pending = serve(request, response).finally(() => { inFlight.delete(pending); });
    inFlight.add(pending);
  });
  server.requestTimeout = 5 * 60 * 1000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Pi bridge did not receive a loopback address.");
  const onAbort = () => cancelPiApprovals(input.runId);
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    url: `http://127.0.0.1:${address.port}`, token, native, businessNames,
    isReady: () => ready,
    result: (callId: string) => results.get(callId),
    close: async () => {
      closed = true;
      signal.removeEventListener("abort", onAbort);
      cancelPiApprovals(input.runId);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.all(inFlight);
      results.clear(); admissions.clear();
    },
  };
}
