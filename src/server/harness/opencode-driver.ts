import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import type {
  Config as OpenCodeConfig,
  Event as OpenCodeEvent,
  SessionPromptData,
} from "@opencode-ai/sdk/client";
import { getDataDir } from "@/db/client";
import { acquireWorkspaceLease, isPlatformWorkspaceLease } from "./workspace-lease";
import { HarnessError } from "./errors";
import {
  OpenCodeEventProjection,
  toHarnessError,
} from "./opencode-events";
import { renderOpenCodeContextPacket, renderOpenCodeSystemPrompt } from "./opencode-packet";
import { type HarnessNativeOutcome } from "./native-tools";
import {
  createOpenCodeToolEndpoint,
  OPENCODE_TOOL_PREFIX,
  type OpenCodeToolEndpoint,
} from "./opencode-mcp";
import { assertHarnessAccessProfile } from "./tool-surface";
import type {
  HarnessAccessMode,
  HarnessCapabilities,
  HarnessDoctor,
  HarnessDriver,
  HarnessEvent,
  HarnessInvocationInput,
  HarnessRunStream,
  HarnessWorkspaceLease,
} from "./types";

/**
 * The pinned OpenCode engine (#25).
 *
 * Both packages are installed at the exact version this driver was written and
 * verified against: `@opencode-ai/sdk` is the typed HTTP/SSE client bundled by
 * the app, and `opencode-ai` ships the platform CLI the SDK client talks to.
 * `doctor()` compares both, so a different CLI on PATH cannot silently serve a
 * different protocol than the generated types.
 */
export const OPENCODE_VERSION = "1.19.3";
export const OPENCODE_SDK_VERSION = "1.19.3";

/** OpenCode's provider id the platform's resolved target is mapped onto. */
const OPENCODE_PROVIDER_ID = "agentmeld";

/** OpenCode's own native tools, disabled for context-only runs. */
const OPENCODE_NATIVE_TOOLS = [
  "bash", "edit", "write", "read", "grep", "glob", "list", "patch",
  "webfetch", "websearch", "todowrite", "todoread", "task", "apply_patch",
  "question", "skill",
] as const;

/**
 * Engine tools a workspace run does not get, because they would leave the
 * platform's evidence and workspace-owned lifecycle:
 *
 * - `task` starts a subagent in a child session whose tool calls never reach
 *   this invocation's bridge or its session-scoped event projection.
 * - `apply_patch` mutates files through a second format the platform has no
 *   admitted native mapping for (`edit` is `fs_patch`).
 * - `question` has no headless interaction channel; the platform's `ask_user`
 *   business tool is the supported way to ask.
 */
const OPENCODE_UNEVIDENCED_TOOLS = ["task", "apply_patch", "question"] as const;

interface OpenCodeInstallation {
  cliPath: string;
  sdkVersion: string;
}

/**
 * Resolve the pinned SDK and CLI from this project's own node_modules.
 *
 * The CLI deliberately does not come from PATH: a developer machine may have a
 * different global OpenCode, and the SDK's generated types are version-bound.
 * `AGENTMELD_OPENCODE_CLI_PATH` exists for tests and for a packaged desktop app
 * that ships the binary elsewhere.
 */
export function openCodeInstallation(): OpenCodeInstallation {
  // Resolve by path, like Pi's `piInstallation`: the SDK is ESM-only (its
  // exports map has no `require` condition), so `createRequire().resolve` cannot
  // see it even though the server imports it fine.
  const sdkPackagePath = path.join(process.cwd(), "node_modules", "@opencode-ai", "sdk", "package.json");
  const sdkPackage = readPackage(sdkPackagePath, "OpenCode SDK");
  if (sdkPackage.version !== OPENCODE_SDK_VERSION) {
    throw new HarnessError(
      `OpenCode SDK ${OPENCODE_SDK_VERSION} is required; this build resolved ${sdkPackage.version ?? "an unknown version"}. ` +
        "Reinstall the locked project dependencies.",
      "version_mismatch",
    );
  }

  const cliPackagePath = path.join(process.cwd(), "node_modules", "opencode-ai", "package.json");
  const cliPackage = readPackage(cliPackagePath, "OpenCode CLI package");
  if (cliPackage.version !== OPENCODE_VERSION) {
    throw new HarnessError(
      `OpenCode ${OPENCODE_VERSION} is required; this build resolved ${cliPackage.version ?? "an unknown version"}. ` +
        "Reinstall the locked project dependencies.",
      "version_mismatch",
    );
  }

  const cliPath = process.env.AGENTMELD_OPENCODE_CLI_PATH
    ? path.resolve(process.env.AGENTMELD_OPENCODE_CLI_PATH)
    : path.join(path.dirname(cliPackagePath), "bin", "opencode.exe");
  if (!fs.existsSync(cliPath) || !fs.statSync(cliPath).isFile()) {
    throw new HarnessError(
      `The OpenCode CLI binary is missing at ${cliPath}. Run \`pnpm rebuild opencode-ai\` to install its platform binary.`,
      "startup",
    );
  }
  return { cliPath, sdkVersion: sdkPackage.version };
}

function readPackage(file: string, label: string): { version?: string } {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string };
  } catch {
    throw new HarnessError(
      `${label} is not installed at ${file}. Reinstall the locked project dependencies.`,
      "startup",
    );
  }
}

function nodeSupportsOpenCode(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

/**
 * Probe the installation without ever throwing.
 *
 * Mirroring Pi's doctor: a missing or broken installation is an availability
 * answer, not an exception. The CLI is actually executed (`--version`) because
 * `opencode-ai` installs a platform-specific binary through a postinstall step;
 * a package that is present but whose postinstall never ran is a stub that exits
 * 1, and that must read as unavailable rather than "installed".
 */
export function getOpenCodeDoctor(): HarnessDoctor {
  try {
    if (!nodeSupportsOpenCode()) {
      throw new HarnessError("OpenCode requires Node.js >=22.19.0.", "startup");
    }
    const installation = openCodeInstallation();
    let reported: string;
    try {
      reported = execFileSync(installation.cliPath, ["--version"], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      })
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .pop() ?? "";
    } catch (error) {
      const detail = error instanceof Error && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").trim()
        : "";
      throw new HarnessError(
        `The OpenCode CLI at ${installation.cliPath} did not run${detail ? `: ${detail}` : "."}`,
        "startup",
      );
    }
    if (reported !== OPENCODE_VERSION) {
      throw new HarnessError(
        `The OpenCode CLI reports "${reported || "no version"}"; ${OPENCODE_VERSION} is required.`,
        "version_mismatch",
      );
    }
    return {
      available: true,
      version: reported,
      detail: `OpenCode ${reported} (SDK ${installation.sdkVersion}) on Node.js ${process.versions.node}.`,
    };
  } catch (error) {
    return {
      available: false,
      detail: error instanceof Error ? error.message : "OpenCode is unavailable.",
    };
  }
}

/** The minimal SDK surface this driver uses; tests substitute a scripted fake. */
export interface OpenCodeClientLike {
  createSession(title: string): Promise<string>;
  subscribe(signal: AbortSignal): Promise<AsyncIterable<OpenCodeEvent>>;
  prompt(sessionId: string, body: NonNullable<SessionPromptData["body"]>): Promise<void>;
  abort(sessionId: string): Promise<void>;
  respondPermission(sessionId: string, permissionId: string, response: "once" | "always" | "reject"): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

/** One running OpenCode server and its typed client. */
export interface OpenCodeEngine {
  /** The server process id, attached to the platform workspace lease. */
  readonly pid: number | null;
  readonly client: OpenCodeClientLike;
  /** Stop the server and report whether its exit was positively confirmed. */
  stop(): Promise<boolean>;
}

export interface OpenCodeEngineStartOptions {
  workspaceRoot: string;
  /** OpenCode's own config document; passed through `OPENCODE_CONFIG_CONTENT`. */
  config: OpenCodeConfig;
  signal: AbortSignal;
  /**
   * Invocation-scoped environment additions (the tool bridge URL/token the
   * native-evidence plugin reads). Kept out of `config` so the secret is not
   * serialized into the config document.
   */
  env?: Record<string, string>;
}

export type OpenCodeEngineFactory = (options: OpenCodeEngineStartOptions) => Promise<OpenCodeEngine>;

/**
 * The production engine: an invocation-scoped `opencode serve` process.
 *
 * The SDK's `createOpencodeServer` cannot set the child's cwd or an isolated
 * XDG home, so the server is spawned here with the same arguments the SDK uses
 * (`serve --hostname --port`) and the SDK client does the typed HTTP/SSE work.
 * The process is detached on POSIX so teardown can kill its whole process group
 * (native bash tools are grandchildren) rather than orphaning them.
 */
async function startOpenCodeEngine(options: OpenCodeEngineStartOptions): Promise<OpenCodeEngine> {
  const installation = openCodeInstallation();
  const port = await freePort();
  const home = path.join(getDataDir(), "opencode");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  const child = spawn(installation.cliPath, ["serve", "--hostname=127.0.0.1", `--port=${port}`, "--log-level=ERROR"], {
    cwd: options.workspaceRoot,
    env: childEnvironment(home, options.config, options.env),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const pid = child.pid ?? null;
  let url: string;
  try {
    url = await waitForServerUrl(child, options.signal);
  } catch (error) {
    // A startup that never produced a URL still owns a process (it may be
    // wedged before listening). It must not outlive the failed invocation.
    await killTree(child);
    throw error;
  }
  const sdk = createOpencodeClient({ baseUrl: url, directory: options.workspaceRoot });
  const directory = options.workspaceRoot;

  return {
    pid,
    client: {
      async createSession(title) {
        const result = await sdk.session.create({ body: { title }, query: { directory } });
        if (result.error || !result.data?.id) throw sdkFailure("OpenCode did not create a session.", result.error);
        return result.data.id;
      },
      async subscribe(signal) {
        const result = await sdk.event.subscribe({ signal, query: { directory } });
        return result.stream;
      },
      async prompt(sessionId, body) {
        const result = await sdk.session.promptAsync({ path: { id: sessionId }, query: { directory }, body });
        if (result.error) throw sdkFailure("OpenCode rejected the prompt.", result.error);
      },
      async abort(sessionId) {
        await sdk.session.abort({ path: { id: sessionId }, query: { directory } }).catch(() => undefined);
      },
      async respondPermission(sessionId, permissionId, response) {
        const result = await sdk.postSessionIdPermissionsPermissionId({
          path: { id: sessionId, permissionID: permissionId },
          query: { directory },
          body: { response },
        });
        if (result.error) throw sdkFailure("OpenCode rejected the permission response.", result.error);
      },
      async deleteSession(sessionId) {
        await sdk.session.delete({ path: { id: sessionId }, query: { directory } }).catch(() => undefined);
      },
    },
    async stop() {
      // Confirmed teardown means the whole process group is gone, not only the
      // leader: native bash tools run as grandchildren and must not outlive the
      // workspace lease that this run is about to release.
      return killTree(child);
    },
  };
}

/**
 * The engine's environment, built deliberately instead of inheriting the app's.
 *
 * Pi already runs with a minimal environment; OpenCode gets the same treatment so
 * an unrelated credential (another provider's key, a channel token) is never
 * visible to the engine or to a bash tool it starts. The only credential present
 * is the platform's resolved target inside `OPENCODE_CONFIG_CONTENT`, and the
 * engine's HOME/XDG roots point at this install's private directory rather than
 * the user's own OpenCode state.
 */
function childEnvironment(home: string, config: OpenCodeConfig, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production" };
  for (const key of [
    "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "SystemDrive",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "COMSPEC", "ComSpec",
    "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    NO_COLOR: "1",
  }, extra ?? {});
  return env;
}

function sdkFailure(fallback: string, error: unknown): HarnessError {
  const message = error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message
    : fallback;
  return new HarnessError(message, "transport");
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new HarnessError("Could not allocate a local port for OpenCode.", "startup"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Wait for the one line the CLI prints when the HTTP server is ready.
 *
 * Without `--print-logs` that line is the only thing on stdout; stderr is kept
 * for the failure message and is deliberately not streamed to the platform log
 * (an engine's own log lines are not platform events).
 */
function waitForServerUrl(child: ChildProcess, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      if (error) reject(error);
      else resolve(url!);
    };
    const onStdout = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/opencode server listening on\s+(https?:\/\/\S+)/);
      if (match) finish(null, match[1]);
    };
    const onStderr = (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    };
    const onExit = (code: number | null) => {
      finish(new HarnessError(
        `OpenCode exited before it began listening (code ${code ?? "unknown"})${stderr ? `: ${stderr.trim()}` : "."}`,
        "startup",
      ));
    };
    const onError = (error: Error) => finish(new HarnessError(`OpenCode could not be started: ${error.message}`, "startup"));
    const onAbort = () => finish(new HarnessError("OpenCode startup was cancelled.", "aborted"));
    const timer = setTimeout(() => finish(new HarnessError("OpenCode did not start within 15 seconds.", "startup")), 15_000);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Kill the server and every process it started; report confirmed teardown. */
async function killTree(child: ChildProcess): Promise<boolean> {
  const pid = child.pid;
  if (!pid) return true;

  if (process.platform === "win32") {
    // Windows has no process-group signal; `taskkill /T` is the supported way
    // to include the native tool children.
    await new Promise<void>(resolve => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return child.exitCode !== null || child.signalCode !== null || waitForExit(child, 2_000);
  }

  const signal = (value: NodeJS.Signals) => {
    try {
      process.kill(-pid, value);
    } catch {
      // The group or the child is already gone; the probes below decide.
    }
  };

  const leaderExited = child.exitCode !== null || child.signalCode !== null;
  if (!leaderExited) {
    signal("SIGTERM");
    await waitForExit(child, 5_000);
  }
  if (await waitForGroupGone(pid, 2_000)) return true;
  signal("SIGKILL");
  return waitForGroupGone(pid, 2_000);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

/**
 * Wait for the run's process group to disappear.
 *
 * On POSIX the server was spawned detached, so its descendants share the group
 * id. Signal 0 is a liveness probe for the group. Windows has no equivalent, so
 * the leader's exit is the observable fact there.
 */
async function waitForGroupGone(pid: number, timeoutMs: number): Promise<boolean> {
  if (process.platform === "win32") return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** Build OpenCode's own config document from the platform's resolved target. */
export function buildOpenCodeConfig(
  input: HarnessInvocationInput,
  access: HarnessAccessMode,
  toolConfig?: OpenCodeToolConfig,
): OpenCodeConfig {
  const modelId = input.provider.modelId;
  const endpoint = input.provider.endpoint;
  const credential = input.provider.credential;
  if (!modelId?.trim()) throw new HarnessError("Select a model before running an Agent.", "configuration");
  if (!endpoint) throw new HarnessError("Select a provider endpoint before running OpenCode.", "configuration");
  if (!credential) {
    throw new HarnessError(
      "The selected OpenCode model has no configured credential. Update the Agent or model provider in Settings.",
      "authentication",
    );
  }
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new HarnessError("The model endpoint is not a valid URL.", "configuration"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new HarnessError(
      "The model endpoint must be an HTTP(S) URL without embedded credentials, query or fragment.",
      "configuration",
    );
  }

  const provider = input.provider.catalogProvider ?? input.provider.providerId;
  // OpenCode loads the provider SDK through `npm`; anthropic-messages endpoints
  // need the Anthropic package, everything else the OpenAI-compatible one.
  const npm = provider === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible";
  const contextLimit = input.provider.contextWindow && input.provider.contextWindow > 0
    ? input.provider.contextWindow
    : null;
  const conversationOnly = access === "conversation";
  const modelLimits = contextLimit
    ? { limit: { context: contextLimit, output: Math.min(65_536, contextLimit) } }
    : {};

  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    model: `${OPENCODE_PROVIDER_ID}/${modelId}`,
    // Title generation must not fall back to the user's own OpenCode credential
    // (which this isolated home deliberately cannot see).
    small_model: `${OPENCODE_PROVIDER_ID}/${modelId}`,
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm,
        name: "AgentMeld",
        options: { baseURL: url.toString().replace(/\/+$/, ""), apiKey: credential },
        models: {
          [modelId]: {
            name: modelId,
            // A context-only invocation without business tools has nothing to
            // call. When the platform does provision business tools (the roster,
            // a consultation reply), the model must still be allowed to call
            // the MCP tools that carry them.
            tool_call: !conversationOnly || toolConfig?.hasBusinessTools === true,
            reasoning: Boolean(input.provider.reasoningEffort),
            attachment: input.provider.vision,
            ...modelLimits,
          },
        },
      },
    },
    // The platform decides the access profile; OpenCode must enforce the same
    // decision itself for its own native tools.
    permission: conversationOnly
      ? { edit: "deny", bash: "deny", webfetch: "deny", external_directory: "deny", doom_loop: "deny" }
      : { edit: "allow", bash: "allow", webfetch: "deny", external_directory: "allow", doom_loop: "allow" },
    ...(toolConfig?.mcp ? { mcp: toolConfig.mcp } : {}),
    ...(toolConfig?.plugin ? { plugin: toolConfig.plugin } : {}),
    ...(conversationOnly ? { tools: disabledTools() } : { tools: disabledWorkspaceTools() }),
  };
}

/** Config shape for the invocation-scoped OpenCode tool transport. */
export interface OpenCodeToolConfig {
  /** `mcp` entries OpenCode should load (present only when business tools exist). */
  mcp?: NonNullable<OpenCodeConfig["mcp"]>;
  /** Absolute plugin paths (the native-admission hook). */
  plugin?: string[];
  hasBusinessTools: boolean;
}

function disabledTools(): Record<string, boolean> {
  return Object.fromEntries(OPENCODE_NATIVE_TOOLS.map(name => [name, false]));
}

function disabledWorkspaceTools(): Record<string, boolean> {
  return Object.fromEntries(OPENCODE_UNEVIDENCED_TOOLS.map(name => [name, false]));
}

function toolFlags(access: HarnessAccessMode): Record<string, boolean> | undefined {
  return access === "conversation" ? disabledTools() : disabledWorkspaceTools();
}

/** A prompt attachment becomes an OpenCode file part when it is inside the workspace. */
function attachmentParts(input: HarnessInvocationInput): NonNullable<SessionPromptData["body"]>["parts"] {
  return input.context.packet.attachments.flatMap(attachment => {
    if (!attachment.workspacePath) return [];
    const absolute = path.resolve(input.workspaceRoot, attachment.workspacePath);
    try {
      if (!fs.statSync(absolute).isFile()) return [];
    } catch {
      return [];
    }
    return [{
      type: "file" as const,
      mime: attachment.mimeType,
      filename: attachment.fileName,
      url: pathToFileURL(absolute).href,
    }];
  });
}

function settledAbortStatus(error: unknown, signal: AbortSignal): "aborted" | "failed" {
  if (!signal.aborted) return "failed";
  return error instanceof HarnessError && error.category === "cleanup_failed" ? "failed" : "aborted";
}

export interface RunOpenCodeOptions {
  /**
   * Test/desktop seam: substitute the server+client. Production omits it, so
   * the real engine is required and `doctor()` is checked before dispatch.
   */
  engineFactory?: OpenCodeEngineFactory;
}

/**
 * Run exactly one invocation through OpenCode and stream neutral events.
 *
 * Extracted from the driver object so the whole lifecycle (lease, session,
 * event mapping, cleanup) can be tested with a scripted engine while the real
 * `run()` remains a thin wrapper that adds `run.started` / `run.settled`.
 */
export async function* runOpenCodeInvocation(
  input: HarnessInvocationInput,
  signal: AbortSignal,
  options: RunOpenCodeOptions = {},
): HarnessRunStream {
  const access: HarnessAccessMode = input.access ?? "workspace";
  const engineFactory = options.engineFactory ?? startOpenCodeEngine;
  assertHarnessAccessProfile(access, input.tools.names);
  if (engineFactory === startOpenCodeEngine) {
    const doctor = getOpenCodeDoctor();
    if (!doctor.available) throw new HarnessError(doctor.detail ?? "OpenCode is unavailable.", "startup");
  }

  const timeout = input.timeoutMs && input.timeoutMs > 0 ? AbortSignal.timeout(input.timeoutMs) : null;
  const effective = timeout ? AbortSignal.any([signal, timeout]) : signal;
  let lease: HarnessWorkspaceLease | null = null;
  let engine: OpenCodeEngine | null = null;
  let client: OpenCodeClientLike | null = null;
  let sessionId: string | null = null;
  let streamAbort: AbortController | null = null;
  let removeAbortListener: (() => void) | null = null;
  let toolEndpoint: OpenCodeToolEndpoint | null = null;

  try {
    effective.throwIfAborted();
    if (access !== "conversation") {
      input.onStage?.("queued");
      lease = input.workspaceLease ?? await acquireWorkspaceLease(input.workspaceRoot, effective, { ownerLabel: "OpenCode" });
      if (!isPlatformWorkspaceLease(lease)) {
        throw new HarnessError("The workspace handoff was not issued by the platform workspace lease manager.", "workspace_ownership");
      }
      const expected = fs.realpathSync.native(input.workspaceRoot);
      if (fs.realpathSync.native(lease.workspacePath) !== expected) {
        throw new HarnessError("The workspace lease belongs to a different workspace.", "workspace_ownership");
      }
      lease.assertActive();
    }

    input.onStage?.("running");
    // The transport is only needed when the platform actually provisioned tools.
    // It is invocation-scoped: a fresh loopback endpoint + bearer token, a stdio
    // MCP server OpenCode spawns, and a plugin for OpenCode's own native tools.
    if (input.tools.names.length > 0) {
      toolEndpoint = await createOpenCodeToolEndpoint(
        input,
        effective,
        lease && isPlatformWorkspaceLease(lease) ? lease : null,
        {
          mcpServerPath: harnessAsset("opencode-mcp-server.mjs"),
          pluginPath: harnessAsset("opencode-evidence-plugin.mjs"),
        },
      );
    }
    const businessTools = toolEndpoint?.businessTools ?? [];
    const toolConfig: OpenCodeToolConfig | undefined = toolEndpoint
      ? {
          mcp: businessTools.length > 0
            ? { [toolEndpoint.serverName]: toolEndpoint.mcpConfig() }
            : undefined,
          plugin: [harnessAsset("opencode-evidence-plugin.mjs")],
          hasBusinessTools: businessTools.length > 0,
        }
      : undefined;
    const systemPrompt = toolEndpoint
      ? renderOpenCodeSystemPrompt(input.context.systemPrompt, {
          native: toolEndpoint.nativeTools,
          business: businessTools,
          serverName: toolEndpoint.serverName,
        })
      : input.context.systemPrompt;

    // A substituted engine (tests/desktop) owns its own transport lifecycle;
    // production must prove both bridge halves came up before the model runs.
    const realEngine = engineFactory === startOpenCodeEngine;
    const config = buildOpenCodeConfig(input, access, toolConfig);
    engine = await engineFactory({
      workspaceRoot: input.workspaceRoot,
      config,
      signal: effective,
      env: toolEndpoint?.pluginEnvironment,
    });
    if (engine.pid !== null) lease?.attachChild(engine.pid);
    client = engine.client;

    sessionId = await client.createSession(`AgentMeld ${input.agent.name}`.slice(0, 120));
    const promptText = renderOpenCodeContextPacket(input.context.packet);
    input.onContextCaptured?.({
      prompt: promptText,
      systemPromptHash: createHash("sha256").update(systemPrompt).digest("hex"),
      // Everything this invocation can actually call: the native family OpenCode
      // implements itself plus the business tools the MCP server advertises.
      toolNames: toolEndpoint
        ? [...toolEndpoint.nativeTools, ...businessTools]
        : [],
      access,
    });

    const streamController = new AbortController();
    streamAbort = streamController;
    const onAbort = () => streamController.abort();
    effective.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => effective.removeEventListener("abort", onAbort);
    const events = await client.subscribe(streamController.signal);
    await client.prompt(sessionId, {
      model: { providerID: OPENCODE_PROVIDER_ID, modelID: input.provider.modelId! },
      system: systemPrompt,
      tools: toolFlags(access),
      parts: [{ type: "text", text: promptText }, ...attachmentParts(input)],
    });
    if (realEngine && toolEndpoint) {
      // OpenCode resolves both transports lazily while it composes the session's
      // toolset: MCP `tools/list` happens per prompt, and a plugin initializes
      // when the prompt starts. Gate after enqueueing (not before, which would
      // deadlock) so a transport that never reported in fails the run instead
      // of letting the model run unaudited or without the business tools.
      if (businessTools.length > 0) await toolEndpoint.awaitMcpReady(15_000, effective);
      if (toolEndpoint.nativeTools.length > 0) await toolEndpoint.awaitPluginReady(15_000, effective);
    }

    const projection = new OpenCodeEventProjection({
      sessionId,
      expectedUserPrompt: promptText,
      toolNamePrefix: toolEndpoint ? `${toolEndpoint.serverName}_` : OPENCODE_TOOL_PREFIX,
    });
    let taskAccepted = false;
    for await (const event of events) {
      if (effective.aborted) break;
      if (event.type === "permission.updated" && event.properties.sessionID === sessionId) {
        // Full-access workspace runs mirror Pi's admitted native tools. A
        // context-only run denies at config level, and network access is never
        // granted (Pi has no web tool either), so anything else is rejected
        // rather than silently approved.
        const allowed = access === "workspace"
          && (event.properties.type === "edit" || event.properties.type === "bash" || event.properties.type === "external_directory");
        await client.respondPermission(sessionId, event.properties.id, allowed ? "once" : "reject").catch(() => undefined);
        continue;
      }
      for (const neutral of projection.observe(event)) {
        // Native outcomes are completed here, not in the plugin: OpenCode's
        // `tool.execute.after` hook never runs when a tool throws, while its
        // event stream reports both success and failure for an admitted call.
        if (neutral.type === "tool.result" && toolEndpoint?.bridge.nativeAdmitted(neutral.callId)) {
          await toolEndpoint.bridge.completeNative(neutral.callId, nativeOutcome(neutral));
        }
        yield neutral;
      }
      const state = projection.state();
      if (!taskAccepted && state.taskAccepted) {
        taskAccepted = true;
        input.onTaskAccepted?.();
      }
      if (state.idle) break;
    }

    if (signal.aborted) throw new HarnessError("The OpenCode run was cancelled.", "aborted");
    if (timeout?.aborted) throw new HarnessError("The OpenCode invocation timed out.", "timeout");
    const state = projection.state();
    if (state.failure) throw toHarnessError(state.failure);
    if (!state.idle) throw new HarnessError("OpenCode disconnected before the run settled.", "process_exit");
    if (!state.sawAssistantMessage) throw new HarnessError("OpenCode settled without a committed assistant turn.", "empty_response");
    // Ownership is asserted again at the terminal event, exactly like Pi: a
    // lease lost mid-run must be a failure, not a quiet success.
    lease?.assertActive();
    for (const neutral of projection.closeAllBlocks()) yield neutral;
    if (state.usage) yield { type: "run.usage", usage: state.usage };
  } catch (error) {
    if (signal.aborted) {
      throw new HarnessError("The OpenCode run was cancelled.", "aborted");
    }
    if (timeout?.aborted) {
      throw new HarnessError("The OpenCode invocation timed out.", "timeout");
    }
    if (error instanceof HarnessError) throw error;
    throw new HarnessError(error instanceof Error ? error.message : "OpenCode failed.", "runtime");
  } finally {
    removeAbortListener?.();
    streamAbort?.abort();
    if (client && sessionId) {
      // Ask the engine to stop model work before the process group is torn down;
      // both are best-effort because the lease, not the API, decides ownership.
      await client.abort(sessionId).catch(() => undefined);
      await client.deleteSession(sessionId).catch(() => undefined);
    }
    const stopped = engine ? await engine.stop().catch(() => false) : true;
    // Close after the engine so a tool call already in flight can settle; the
    // close revokes the token and cancels any pending platform approvals.
    const transportStopped = await (toolEndpoint?.close() ?? Promise.resolve()).then(
      () => true,
      () => false,
    );
    if (lease) {
      if (stopped && transportStopped) lease.release();
      else lease.poison();
    }
    if (!stopped) {
      // eslint-disable-next-line no-unsafe-finally -- unconfirmed teardown must override the run result
      throw new HarnessError(
        "OpenCode process teardown could not be confirmed; the workspace remains locked.",
        "cleanup_failed",
      );
    }
    if (!transportStopped) {
      // The engine is gone but its bridge could not be revoked. Treat the
      // ownership as uncertain rather than admitting a later writer.
      // eslint-disable-next-line no-unsafe-finally -- an unrevoked bridge must override the run result
      throw new HarnessError(
        "OpenCode's tool bridge could not be revoked; the workspace remains locked.",
        "cleanup_failed",
      );
    }
  }
}

/**
 * Where the driver's runtime assets live. The Pi driver resolves its extension
 * the same way: the server runs from the project root, and a packaged desktop
 * build may point `AGENTMELD_OPENCODE_CLI_PATH` elsewhere but not these files.
 */
function harnessAsset(name: string): string {
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "src", "server", "harness", name);
}

/** The engine's native outcome in the smallest neutral shape. */
function nativeOutcome(event: Extract<HarnessEvent, { type: "tool.result" }>): HarnessNativeOutcome {
  const result = event.result && typeof event.result === "object"
    ? event.result as { output?: unknown; error?: unknown }
    : {};
  const text = event.isError
    ? (typeof result.error === "string" && result.error.length > 0 ? result.error : "Native OpenCode tool failed.")
    : (typeof result.output === "string" ? result.output : "");
  return { text, isError: event.isError };
}

/**
 * The driver-level stream: bracket one invocation with the two lifecycle events
 * every harness reports.
 *
 * `options` is the same test/desktop seam as `runOpenCodeInvocation`; production
 * callers use `opencodeHarnessDriver.run(input, signal)`.
 */
export async function* runOpenCodeHarness(
  input: HarnessInvocationInput,
  signal: AbortSignal,
  options: RunOpenCodeOptions = {},
): HarnessRunStream {
  yield { type: "run.started" };
  try {
    yield* runOpenCodeInvocation(input, signal, options);
  } catch (error) {
    const failure = error instanceof HarnessError
      ? error
      : new HarnessError(error instanceof Error ? error.message : "OpenCode failed.", "runtime");
    yield {
      type: "run.settled",
      status: settledAbortStatus(failure, signal),
      reason: failure.message,
    };
    throw failure;
  }
  yield { type: "run.settled", status: "completed" };
}

/**
 * The OpenCode driver.
 *
 * Capabilities are declared exactly as wired in this slice. OpenCode brings its
 * own native file/shell tools, and its event stream carries their lifecycle, but
 * this driver does not yet carry platform business tools over OpenCode's
 * transport and does not admit/hash native outcomes through the platform tool
 * bridge. `businessTools` and `evidence` are therefore false: artifact-producing
 * and delegated runs fail through `assertHarnessSupports` before any work begins
 * rather than producing output the platform cannot verify.
 */
export const opencodeHarnessDriver: HarnessDriver = {
  id: "opencode",

  doctor(): HarnessDoctor {
    return getOpenCodeDoctor();
  },

  capabilities(): HarnessCapabilities {
    return {
      // OpenCode's own read/write/edit/bash/grep/glob/… toolset.
      nativeTools: true,
      // Not wired in this slice: no business-tool transport exists for OpenCode.
      businessTools: false,
      // The platform owns the AbortSignal; `session.abort` and process teardown
      // are driven from it. There is no run-id abort registry.
      cancellation: { supported: true, mode: "signal" },
      // Native outcomes are visible as tool events but are not admitted or
      // hashed by the platform tool bridge, so they cannot become evidence.
      evidence: false,
      // The platform packet is rendered into OpenCode's prompt and system field.
      contextPacket: "platform",
      // No live steering/follow-up channel is wired.
      followUp: false,
      // OpenCode streams message/part updates, which are projected as deltas.
      streaming: true,
    };
  },

  run: runOpenCodeHarness,

  // OpenCode has a session abort endpoint, but the platform only ever cancels
  // through the signal it hands `run`; there is no run-id registry to invent.
  abort(): boolean {
    return false;
  },
};

