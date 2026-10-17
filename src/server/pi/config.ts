import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getDataDir, getDatabase } from "@/db/client";
import { getModelLimits, resolveContextWindow } from "@/shared/model-registry";
import { getSettings, resolveApiKey } from "@/server/settings-service";
import { resolveProviderBaseUrl } from "@/server/provider-endpoints";
import type { PiInvocationInput, PiProviderSnapshot } from "./types";
import type { Agent } from "@/shared/types";
import { createRequire } from "node:module";
import type { deepseekProvider as DeepseekProviderFn } from "@earendil-works/pi-ai/providers/deepseek";
import { PiRuntimeError } from "./process";
import type { UsagePayload } from "@/shared/types";

export const PI_VERSION = "0.84.2";

export interface PiDoctorResult {
  available: boolean;
  expectedVersion: string;
  installedVersion: string | null;
  nodeVersion: string;
  error: string | null;
}

export function piInstallation(): { cliPath: string; version: string } {
  const cliPath = process.env.AGENTMELD_PI_CLI_PATH
    ? path.resolve(process.env.AGENTMELD_PI_CLI_PATH)
    : path.join(/*turbopackIgnore: true*/ process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const packageFile = path.resolve(path.dirname(cliPath), "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { name?: string; version?: string };
  if (pkg.name !== "@earendil-works/pi-coding-agent" || pkg.version !== PI_VERSION || !fs.statSync(cliPath).isFile()) {
    throw new PiRuntimeError(`Pi ${PI_VERSION} is required. Reinstall the locked project dependencies.`, "version_mismatch");
  }
  return { cliPath, version: pkg.version };
}

export function getPiDoctor(): PiDoctorResult {
  const result: PiDoctorResult = { available: false, expectedVersion: PI_VERSION, installedVersion: null, nodeVersion: process.versions.node, error: null };
  try {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19)) throw new Error("Pi requires Node.js >=22.19.0.");
    result.installedVersion = piInstallation().version;
    result.available = true;
  } catch (error) { result.error = error instanceof Error ? error.message : "Pi is unavailable."; }
  return result;
}

/**
 * The DeepSeek model catalog, loaded without the package's exports map.
 *
 * `@earendil-works/pi-ai` declares `./providers/*` with only a `types` and an
 * `import` condition — no `require`. The app bundles it as ESM and is fine, but
 * anything resolving it as CommonJS (the benchmark harness, via tsx) fails with
 * "Package subpath './providers/deepseek' is not defined by exports" even
 * though the file is right there in `dist/`. Resolving the built file by
 * absolute path sidesteps the map; the catalog only tunes limits, so a failure
 * falls back to the built-in numbers instead of taking the runtime down.
 */
let cachedDeepseekProvider: typeof DeepseekProviderFn | null = null;
let deepseekProviderResolved = false;
function loadDeepseekProvider(): typeof DeepseekProviderFn | null {
  if (deepseekProviderResolved) return cachedDeepseekProvider;
  deepseekProviderResolved = true;
  try {
    const requireFromProject = createRequire(path.join(process.cwd(), "package.json"));
    const entry = requireFromProject.resolve("@earendil-works/pi-ai");
    const module_ = requireFromProject(path.join(path.dirname(entry), "providers", "deepseek.js"));
    cachedDeepseekProvider = typeof module_.deepseekProvider === "function" ? module_.deepseekProvider : null;
  } catch {
    cachedDeepseekProvider = null;
  }
  return cachedDeepseekProvider;
}

export function preparePiInvocation(input: PiInvocationInput) {
  const doctor = getPiDoctor();
  if (!doctor.available) throw new PiRuntimeError(doctor.error ?? "Pi is unavailable.", "startup");
  const installation = piInstallation();
  const provider = input.agent.modelProvider ?? "deepseek";
  const apiKey = input.apiKey;
  if (!apiKey) throw new PiRuntimeError("The selected Pi model has no configured credential. Update the Agent or model provider in Settings.", "authentication");
  const baseUrl = input.apiBaseUrl;
  if (!baseUrl || !input.agent.modelId?.trim()) throw new PiRuntimeError("Select a model and provider endpoint before running Pi.", "configuration");
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); }
  catch { throw new PiRuntimeError("The model endpoint is not a valid URL.", "configuration"); }
  if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new PiRuntimeError("The model endpoint must be an HTTP(S) URL without embedded credentials, query or fragment.", "configuration");
  const invocationId = `pi_${randomUUID()}`;
  const home = path.join(getDataDir(), "pi", "executions", invocationId);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const limits = getModelLimits(input.agent.modelProvider);
  const deepseek = (input.catalogProvider ?? provider) === "deepseek";
  const catalogProvider = deepseek ? loadDeepseekProvider() : null;
  const nativeModel = catalogProvider
    ? catalogProvider().getModels().find(model => model.id === input.agent.modelId)
    : undefined;
  // Preserve master's verified 64K output allowance for legacy DeepSeek aliases.
  // Known models use the locked Pi catalog, rather than hand-maintained limits.
  // The window itself comes from the Agent's configured value (or the verified
  // provider default), so Pi's in-run compactor and our 80% trigger agree.
  const contextWindow = resolveContextWindow(input.agent, nativeModel?.contextWindow);
  const maxTokens = nativeModel?.maxTokens ?? (deepseek ? 65_536 : limits.outputReserve);
  const reasoningEffort = input.agent.reasoningEffort;
  fs.writeFileSync(path.join(home, "models.json"), JSON.stringify({ providers: { agentmeld: {
    api: provider === "anthropic" ? "anthropic-messages" : "openai-completions",
    baseUrl, apiKey: "$AGENTMELD_PI_MODEL_KEY", authHeader: true,
    compat: { ...nativeModel?.compat, supportsDeveloperRole: false,
      // Pi only sends `reasoning_effort` when this bit is on. The gateway
      // accepts low|high (verified against usage.reasoning_tokens); leaving it
      // off when no effort is configured keeps the previous request body.
      supportsReasoningEffort: Boolean(reasoningEffort),
      ...(deepseek ? { supportsStore: false, maxTokensField: "max_tokens", requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" } : {}) },
    models: [{ id: input.agent.modelId, name: input.agent.modelId,
      reasoning: Boolean(reasoningEffort) || (nativeModel?.reasoning ?? deepseek),
      input: nativeModel?.input ?? (input.agent.supportsVision && !deepseek ? ["text", "image"] : ["text"]),
      contextWindow, maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({
    defaultProvider: "agentmeld", defaultModel: input.agent.modelId,
    // Pi compacts a single run internally; it must see the same window and
    // keep the recent 100k it was told to. App-level compaction (80%, across
    // runs) is a different compactor and lives in conversation-context.ts.
    compaction: { enabled: true, keepRecentTokens: 100_000 },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 },
  }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production" };
  // Pi discovers Git Bash through the Windows installation directories before
  // considering PATH, which may otherwise select the legacy WSL launcher.
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "SystemDrive", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "COMSPEC", "ComSpec", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home,
    PI_OFFLINE: "1", NO_COLOR: "1", AGENTMELD_PI_MODEL_KEY: apiKey });
  const credentialRef = input.agent.apiKey ? `agent:${input.agent.id}` : `provider:${provider}`;
  const configuration = { harness: "pi", version: PI_VERSION, modelProvider: provider,
    modelId: input.agent.modelId, baseUrl, toolNames: input.toolNames,
    agentUpdatedAt: input.agent.updatedAt, credentialRef, providerRevision: input.providerRevision,
    catalogProvider: input.catalogProvider, contextWindow, maxTokens, reasoningEffort };
  const bindingVersion = createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
  persistExecution(invocationId, input, home, bindingVersion, configuration);
  return { ...installation, invocationId, home, env, bindingVersion };
}

export function capturePiConfiguration(input: PiInvocationInput): PiInvocationInput {
  const resolved = input.providerRevision !== undefined ? input : snapshotPiProvider(input.agent);
  return { ...input, agent: { ...input.agent, capabilities: [...input.agent.capabilities], toolNames: [...input.agent.toolNames] },
    toolNames: [...input.toolNames], providerRevision: resolved.providerRevision, catalogProvider: resolved.catalogProvider,
    apiKey: input.providerRevision !== undefined ? input.apiKey : input.apiKey ?? resolved.apiKey,
    apiBaseUrl: input.providerRevision !== undefined ? input.apiBaseUrl : input.apiBaseUrl ?? resolved.apiBaseUrl };
}

export function snapshotPiProvider(agent: Agent): PiProviderSnapshot {
  const provider = agent.modelProvider ?? "deepseek";
  const settings = getSettings();
  const revision = provider.startsWith("profile:")
    ? getDatabase().prepare("SELECT updated_at,preset_id FROM model_provider_profiles WHERE id=?").get(provider.slice(8)) as { updated_at: number; preset_id?: string } | undefined
    : getDatabase().prepare("SELECT updated_at FROM app_settings WHERE id='singleton'").get() as { updated_at: number; preset_id?: string } | undefined;
  return { providerRevision: `${provider}:${revision?.updated_at ?? 0}`, catalogProvider: revision?.preset_id ?? provider,
    apiKey: resolveApiKey(provider, agent.apiKey, settings),
    apiBaseUrl: resolveProviderBaseUrl(provider, agent.apiBaseUrl ?? (provider === "anthropic" ? settings.anthropicBaseUrl : null)) };
}

function persistExecution(id: string, input: PiInvocationInput, home: string, version: string, config: object): void {
  const db = getDatabase();
  const bindingId = `pi_binding_${input.agent.id}_${version}`;
  db.prepare("INSERT OR IGNORE INTO agent_execution_bindings (id,agent_id,harness_id,version,configuration_json,created_at) VALUES (?,?,?,?,?,?)")
    .run(bindingId, input.agent.id, "pi", version, JSON.stringify(config), Date.now());
  db.prepare("INSERT INTO harness_executions (id,run_id,binding_id,agent_id,task_identity_json,workspace_path,session_home,status,started_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, input.runId, bindingId, input.agent.id, input.taskExecution ? JSON.stringify(input.taskExecution) : null, input.workspacePath, home, "starting", Date.now());
}

export function updatePiSession(id: string, sessionId: string, sessionFile: string | null): void {
  getDatabase().prepare("UPDATE harness_executions SET native_session_id=?, native_session_file=?, status='running' WHERE id=? AND finished_at IS NULL")
    .run(sessionId, sessionFile, id);
}

export function finishPiExecution(id: string, status: "complete" | "failed" | "aborted" | "interrupted", category: string | null): void {
  getDatabase().prepare("UPDATE harness_executions SET status=?, error_category=?, finished_at=? WHERE id=? AND finished_at IS NULL")
    .run(status, category, Date.now(), id);
}

export function persistPiUsage(id: string, usage: UsagePayload | null): void {
  if (usage) getDatabase().prepare("UPDATE harness_executions SET usage_json=? WHERE id=?").run(JSON.stringify(usage), id);
}

export function getPiRunUsage(runId: string): UsagePayload | null {
  const rows = getDatabase().prepare("SELECT usage_json FROM harness_executions WHERE run_id=?").all(runId) as Array<{ usage_json: string | null }>;
  if (!rows.length || rows.some(row => row.usage_json === null)) return null;
  return rows.reduce<UsagePayload>((total, row) => {
    const usage = JSON.parse(row.usage_json!) as UsagePayload;
    return { modelId: usage.modelId, inputTokens: (total.inputTokens ?? 0) + (usage.inputTokens ?? 0), outputTokens: (total.outputTokens ?? 0) + (usage.outputTokens ?? 0) };
  }, {});
}
