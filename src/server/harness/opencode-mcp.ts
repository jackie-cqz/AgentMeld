import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  createHarnessToolBridge,
  HarnessToolBridgeError,
  type HarnessToolBridge,
} from "./tool-bridge";
import { assertHarnessAccessProfile } from "./tool-surface";
import { HarnessError } from "./errors";
import type { HarnessInvocationInput, LendableWorkspaceLease } from "./types";

/**
 * The OpenCode transport for the neutral tool bridge.
 *
 * OpenCode 1.19.3 can load MCP servers from its config (`mcp` -> a `local`
 * stdio server) and exposes every advertised tool to the model. The platform
 * therefore runs two tiny, invocation-scoped processes:
 *
 * 1. this loopback HTTP endpoint, which owns the neutral `HarnessToolBridge`
 *    (catalogue, admission, approvals, replay protection, artifact binding,
 *    evidence) exactly like Pi's loopback server does; and
 * 2. `opencode-mcp-server.mjs`, spawned by OpenCode, which speaks MCP over
 *    stdio and forwards `tools/call` to this endpoint.
 *
 * The native file/shell tools stay OpenCode's own. Their pre-execution
 * admission comes from `opencode-evidence-plugin.mjs` (OpenCode's
 * `tool.execute.before` hook); their outcomes are completed here from the
 * driver's event stream. Nothing in this module re-implements a tool: every
 * decision is made by `createHarnessToolBridge`.
 *
 * The endpoint is private (127.0.0.1, random port), per invocation, bearer-token
 * authenticated with a constant-time comparison, and revoked when the run is
 * torn down. Nothing is registered in the public Next API.
 */

/** OpenCode exposes MCP tools as `<server>_<tool>`; this is that server name. */
export const OPENCODE_MCP_SERVER_NAME = "agentmeld";

/** The prefix OpenCode puts in front of every MCP business tool. */
export const OPENCODE_TOOL_PREFIX = `${OPENCODE_MCP_SERVER_NAME}_`;

/** The two transport halves that report for duty over `/ready`. */
type ReadyKind = "mcp" | "plugin";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

const toolCallSchema = z.object({
  callId: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  args: z.record(z.string(), z.unknown()),
});

const nativeCallSchema = z.object({
  callId: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  args: z.record(z.string(), z.unknown()),
  targetPath: z.string().nullable().optional(),
  command: z.string().optional(),
  timeoutMs: z.number().optional(),
  change: z.object({ path: z.string().min(1), content: z.string() }).nullable().optional(),
});

const readySchema = z.object({ kind: z.enum(["mcp", "plugin"]) });

export interface OpenCodeToolEndpoint {
  /** Name OpenCode must use for the MCP server (and therefore the tool prefix). */
  readonly serverName: string;
  /** Business tools the MCP server advertises, in platform names. */
  readonly businessTools: readonly string[];
  /** Platform-native tools this invocation provisions. */
  readonly nativeTools: readonly string[];
  /** The bridge itself: the driver completes native outcomes in-process. */
  readonly bridge: HarnessToolBridge;
  /** Environment for the OpenCode server process (read by the evidence plugin). */
  readonly pluginEnvironment: Record<string, string>;
  /** The MCP document `mcp` entry for OpenCode's config. */
  mcpConfig(): { type: "local"; command: string[]; environment: Record<string, string>; enabled: boolean; timeout: number };

  /** Resolve once OpenCode fetched the business-tool catalogue. */
  awaitMcpReady(timeoutMs: number, signal: AbortSignal): Promise<void>;
  /** Resolve once the native-evidence plugin reported for duty. */
  awaitPluginReady(timeoutMs: number, signal: AbortSignal): Promise<void>;

  /** Revoke the token, stop admitting calls and release the listener. */
  close(): Promise<void>;
}

export async function createOpenCodeToolEndpoint(
  input: HarnessInvocationInput,
  signal: AbortSignal,
  lease: LendableWorkspaceLease | null,
  options: {
    /** Path of the stdio MCP server OpenCode should spawn. */
    mcpServerPath: string;
    /** Absolute path of the evidence plugin (loaded by OpenCode). */
    pluginPath: string;
  },
): Promise<OpenCodeToolEndpoint> {
  assertHarnessAccessProfile(input.access, input.tools.names);
  const bridge = createHarnessToolBridge({
    conversationId: input.conversationId,
    agentId: input.agent.id,
    runId: input.runId,
    parentRunId: input.parentRunId,
    workspacePath: input.workspaceRoot,
    taskExecution: input.taskExecution,
    taskContract: input.taskContract,
    signal,
    toolNames: input.tools.names,
    lease,
    source: "opencode",
    engineLabel: "OpenCode",
    nativeFailureMessage: "Native OpenCode tool failed.",
    access: input.access,
  });

  const token = randomBytes(32).toString("hex");
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const inFlight = new Set<Promise<void>>();
  let closed = false;
  // Both halves report readiness over this endpoint, and each arrives at its own
  // time: the native-admission plugin initializes while OpenCode bootstraps the
  // session, the MCP server only after the prompt makes OpenCode resolve the
  // session's toolset. A waiter therefore has to be woken by the report, not
  // checked once when the wait starts.
  const ready: Record<ReadyKind, boolean> = { mcp: false, plugin: false };
  const readyWaiters = new Set<{ kind: ReadyKind; wake: () => void }>();
  const markReady = (kind: ReadyKind) => {
    ready[kind] = true;
    for (const waiter of [...readyWaiters]) {
      if (waiter.kind !== kind) continue;
      readyWaiters.delete(waiter);
      waiter.wake();
    }
  };

  const serve = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const authorization = Buffer.from(request.headers.authorization ?? "");
    if (
      closed ||
      signal.aborted ||
      authorization.length !== expectedAuthorization.length ||
      !timingSafeEqual(authorization, expectedAuthorization)
    ) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json");
    const send = (body: unknown, status = 200) => {
      if (!response.destroyed) response.writeHead(status).end(JSON.stringify(body));
    };
    try {
      if (request.method === "GET" && request.url === "/manifest") {
        send({
          server: OPENCODE_MCP_SERVER_NAME,
          definitions: bridge.catalogue,
          native: bridge.nativeTools,
        });
        return;
      }
      if (request.method !== "POST") {
        send({ error: "Unknown bridge operation." }, 404);
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_BODY_BYTES) throw new Error("Tool request exceeds its byte limit.");
        chunks.push(buffer);
      }
      signal.throwIfAborted();
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.url === "/ready") {
        const value = readySchema.parse(body);
        markReady(value.kind);
        send({ ok: true });
        return;
      }
      if (request.url === "/native/authorize") {
        const value = nativeCallSchema.parse(body);
        await bridge.beginNative({
          callId: value.callId,
          name: value.name,
          args: value.args,
          targetPath: value.targetPath,
          command: value.command,
          timeoutMs: value.timeoutMs,
        });
        if (value.change) {
          await bridge.authorizeNativeChange(value.callId, value.change.path, value.change.content);
        }
        send({ ok: true });
        return;
      }
      if (request.url === "/tool") {
        const value = toolCallSchema.parse(body);
        send(await bridge.invoke(value.name, value.args, value.callId));
        return;
      }
      send({ ok: false, error: "Tool is not authorized for this invocation." }, 403);
    } catch (error) {
      const status = error instanceof HarnessToolBridgeError && error.reason === "not_provisioned" ? 403 : 400;
      send({ ok: false, error: error instanceof Error ? error.message : "Tool bridge rejected the request." }, status);
    }
  };

  const server = http.createServer((request, response) => {
    const pending = serve(request, response).finally(() => { inFlight.delete(pending); });
    inFlight.add(pending);
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await bridge.close().catch(() => { /* The listen failure is the error worth reporting. */ });
    throw new HarnessError(
      `OpenCode's tool bridge could not start: ${error instanceof Error ? error.message : "lister failure"}`,
      "startup",
    );
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await bridge.close().catch(() => { /* Nothing was admitted; report the address failure. */ });
    throw new HarnessError("OpenCode's tool bridge did not receive a loopback address.", "startup");
  }
  const url = `http://127.0.0.1:${address.port}`;
  const pluginEnvironment = {
    AGENTMELD_OPENCODE_BRIDGE_URL: url,
    AGENTMELD_OPENCODE_BRIDGE_TOKEN: token,
  };

  const awaitReady = (kind: ReadyKind, timeoutMs: number, abort: AbortSignal, detail: string) => {
    if (ready[kind]) return Promise.resolve();
    if (abort.aborted) return Promise.reject(new HarnessError("The OpenCode run was cancelled.", "aborted"));
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiter = { kind, wake: () => finish() };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        abort.removeEventListener("abort", onAbort);
        readyWaiters.delete(waiter);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new HarnessError("The OpenCode run was cancelled.", "aborted"));
      const timer = setTimeout(
        () => finish(new HarnessError(detail, "extension_unavailable")),
        timeoutMs,
      );
      readyWaiters.add(waiter);
      abort.addEventListener("abort", onAbort, { once: true });
    });
  };

  return {
    serverName: OPENCODE_MCP_SERVER_NAME,
    businessTools: bridge.businessTools,
    nativeTools: bridge.nativeTools,
    bridge,
    pluginEnvironment,

    mcpConfig() {
      return {
        type: "local" as const,
        command: [process.execPath, options.mcpServerPath],
        environment: pluginEnvironment,
        enabled: true,
        timeout: 10_000,
      };
    },

    awaitMcpReady(timeoutMs, abort) {
      return awaitReady(
        "mcp",
        timeoutMs,
        abort,
        "OpenCode did not expose the platform business tools; nothing was executed.",
      );
    },

    awaitPluginReady(timeoutMs, abort) {
      return awaitReady(
        "plugin",
        timeoutMs,
        abort,
        "OpenCode's native-tool admission plugin did not initialize; nothing was executed.",
      );
    },

    async close() {
      if (closed) return;
      closed = true;
      await bridge.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.all(inFlight);
    },
  };
}
