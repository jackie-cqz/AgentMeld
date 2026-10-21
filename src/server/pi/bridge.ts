import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  cancelPendingApprovalsForRun,
  createHarnessToolBridge,
  HarnessToolBridgeError,
} from "@/server/harness/tool-bridge";
import { assertHarnessAccessProfile } from "@/server/harness/tool-surface";
import type { PiInvocationInput } from "./types";
import { nativeResultText, nativeToolNames, PI_NATIVE_TO_PLATFORM } from "./native-tools";
import { CONVERSATION_ROSTER_TOOL } from "./tool-surface";
import type { PiWorkspaceLease } from "./workspace-lease";

const callSchema = z.object({ callId: z.string().min(1).max(200), name: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()) });
const outcomeSchema = z.object({ callId: z.string().min(1).max(200), result: z.unknown(), isError: z.boolean() });

/**
 * Pi's cancellation hook keeps its historical name; the work is platform-owned
 * because pending approvals belong to the run, not to the engine.
 */
export const cancelPiApprovals = cancelPendingApprovalsForRun;

/**
 * A private, invocation-scoped loopback transport for the platform tool bridge.
 *
 * Everything the platform decides — the business-tool catalogue, admission,
 * approvals, evidence, replay protection, terminal-tool gating and the
 * consultation workspace lend — happens in
 * `src/server/harness/tool-bridge.ts`. This module only carries those calls over
 * HTTP with a per-invocation bearer token, parses Pi's wire shapes and performs
 * Pi's own turn budget and manifest prompt shaping. Nothing is registered in the
 * public Next API.
 */
export async function createPiBridge(input: PiInvocationInput, signal: AbortSignal, onBudgetExceeded: () => void, lease: PiWorkspaceLease | null = null) {
  // The access rule is platform-owned; check it here as well so Pi refuses an
  // invalid access profile before any other configuration complaint.
  assertHarnessAccessProfile(input.accessMode, input.toolNames);
  const maxTurns = input.maxTurns ?? 64;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 64) throw new Error("Invalid Pi turn limit.");
  const toolBridge = createHarnessToolBridge({
    conversationId: input.conversationId,
    agentId: input.agent.id,
    runId: input.runId,
    parentRunId: input.parentRunId,
    workspacePath: input.workspacePath,
    taskExecution: input.taskExecution,
    taskContract: input.taskContract,
    signal,
    toolNames: input.toolNames,
    lease,
    source: "pi",
    engineLabel: "Pi",
    nativeFailureMessage: "Native Pi tool failed.",
    access: input.accessMode,
  });

  // Pi's own vocabulary: the same platform surface, named the way Pi names it.
  const native = nativeToolNames(toolBridge.nativeTools);
  const businessNames = toolBridge.businessTools;
  const definitions = toolBridge.catalogue;
  const token = randomBytes(32).toString("hex");
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const inFlight = new Set<Promise<void>>();
  let closed = false;
  let turns = 0;
  let ready = false;

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
        const systemPrompt = Object.entries(PI_NATIVE_TO_PLATFORM).reduce((prompt, [nativeName, platform]) =>
          nativeName === platform ? prompt : prompt.replace(new RegExp(`\\b${platform}\\b`, "g"), nativeName), input.systemPrompt);
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
        await toolBridge.completeNative(value.callId, { text: nativeResultText(value.result), isError: value.isError });
        send({ ok: true });
        return;
      }
      if (request.url === "/native/change") {
        const change = z.object({ callId: z.string(), path: z.string(), content: z.string() }).parse(body);
        await toolBridge.authorizeNativeChange(change.callId, change.path, change.content);
        send({ ok: true });
        return;
      }
      const call = callSchema.parse(body);
      if (request.url === "/native/authorize") {
        await toolBridge.beginNative({
          callId: call.callId,
          name: PI_NATIVE_TO_PLATFORM[call.name] ?? call.name,
          args: call.args,
          targetPath: typeof call.args.path === "string" ? call.args.path : ".",
          command: call.args.command as string | undefined,
          timeoutMs: typeof call.args.timeout === "number" ? call.args.timeout * 1000 : undefined,
        });
        send({ ok: true });
      } else if (request.url === "/tool") {
        send(await toolBridge.invoke(call.name, call.args, call.callId));
      } else {
        send({ ok: false, error: "Tool is not authorized for this invocation." }, 403);
      }
    } catch (error) {
      const status = error instanceof HarnessToolBridgeError && error.reason === "not_provisioned" ? 403 : 400;
      send({ ok: false, error: error instanceof Error ? error.message : "Tool bridge rejected the request." }, status);
    }
  };
  const server = http.createServer((request, response) => {
    const pending = serve(request, response).finally(() => { inFlight.delete(pending); });
    inFlight.add(pending);
  });
  server.requestTimeout = 5 * 60 * 1000;
  server.headersTimeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
  } catch (error) {
    await toolBridge.close().catch(() => { /* The listen failure is the error worth reporting. */ });
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await toolBridge.close().catch(() => { /* Nothing was admitted; report the address failure. */ });
    throw new Error("Pi bridge did not receive a loopback address.");
  }
  return {
    url: `http://127.0.0.1:${address.port}`, token, native, businessNames,
    isReady: () => ready,
    result: (callId: string) => toolBridge.result(callId),
    close: async () => {
      closed = true;
      await toolBridge.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.all(inFlight);
    },
  };
}
