import { ensureDatabase } from "@/db/bootstrap";
import { getDatabase } from "@/db/client";
import { listAgents, getAgent } from "@/server/repositories";
import { newAgentId } from "@/shared/ids";
import { TOOL_PRESETS, DEFAULT_CUSTOM_PROMPT } from "@/shared/agent-constants";
import {
  harnessDescriptor,
  isRetiredAdapter,
  isSelectableAdapter,
  unregisteredHarnessFailure,
} from "@/shared/harness-catalog";
import type { AdapterName, Agent, ModelProvider, ReasoningEffort } from "@/shared/types";
import { requireModelProviderProfile } from "@/server/model-provider-service";

export { TOOL_PRESETS, ALL_TOOL_NAMES, DEFAULT_CUSTOM_PROMPT } from "@/shared/agent-constants";
export type { ToolPresetName } from "@/shared/agent-constants";

// ---------------------------------------------------------------------------
// Agent CRUD
// ---------------------------------------------------------------------------

export interface CreateAgentInput {
  name: string;
  avatar?: string;
  description?: string;
  capabilities?: string[];
  adapterName: AdapterName;
  modelProvider?: ModelProvider | null;
  modelId?: string | null;
  apiKey?: string | null;
  apiBaseUrl?: string | null;
  /** Null means "use the provider default" (DeepSeek: 1,000,000). */
  contextWindow?: number | null;
  /** Null keeps today's behaviour: Pi runs without thinking. */
  reasoningEffort?: ReasoningEffort | null;
  systemPrompt?: string;
  toolNames?: string[];
}

export interface UpdateAgentInput {
  adapterName?: AdapterName;
  name?: string;
  avatar?: string;
  description?: string;
  capabilities?: string[];
  modelProvider?: ModelProvider | null;
  modelId?: string | null;
  apiKey?: string | null;
  apiBaseUrl?: string | null;
  contextWindow?: number | null;
  reasoningEffort?: ReasoningEffort | null;
  systemPrompt?: string;
  toolNames?: string[];
}

export function getAgentById(agentId: string): Agent | null {
  return getAgent(agentId);
}

export function getAllAgents(): Agent[] {
  // Services own bootstrapping in this repository. Reaching the repository
  // directly answered 500 with "no such table: agents" on a database that had
  // not been bootstrapped yet.
  ensureDatabase();
  return listAgents();
}

/**
 * Resolve the harness a brand-new Agent may be created with.
 *
 * The catalog is the allowlist (Pi plus `opencode`, whose driver this build
 * deliberately does not ship). Retired names keep their exact historical create
 * error; an unknown name is reported as unavailable, never as retired, so the
 * user is not sent to a migration that cannot help.
 */
function newAgentHarness(name: AdapterName): AdapterName {
  if (isSelectableAdapter(name)) return name;
  if (isRetiredAdapter(name)) throw new Error("New Agents must use the Pi execution engine.");
  throw new Error(unregisteredHarnessFailure(name).message);
}

export function createAgent(input: CreateAgentInput): Agent {
  const db = getDatabase();
  const id = newAgentId();
  const now = Date.now();

  // The catalog decides what a new Agent may select. `opencode` is accepted
  // even though this build registers no OpenCode driver: the row is the user's
  // real, durable choice and a run must fail honestly (`harness_unavailable`),
  // not silently become Pi. Retired names keep their historical error.
  const adapterName = newAgentHarness(input.adapterName);
  const toolNames = input.toolNames ?? TOOL_PRESETS["all-purpose"].tools;
  const modelProvider = input.modelProvider ?? "deepseek";
  validateCustomAgentConfig(adapterName, modelProvider, input.modelId, input.apiKey, input.apiBaseUrl);
  const contextWindow = validateContextWindow(input.contextWindow);
  const reasoningEffort = validateReasoningEffort(input.reasoningEffort);

  db.prepare(`
    INSERT INTO agents (
      id, name, avatar, description, capabilities, system_prompt,
      adapter_name, model_provider, model_id, api_key, api_base_url,
      context_window, reasoning_effort,
      tool_names, is_builtin, is_conductor, supports_vision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name.trim(),
    input.avatar ?? "🤖",
    input.description ?? "",
    JSON.stringify(input.capabilities ?? []),
    input.systemPrompt ?? DEFAULT_CUSTOM_PROMPT,
    adapterName,
    modelProvider,
    input.modelId?.trim() || null,
    input.apiKey?.trim() || null,
    input.apiBaseUrl?.trim() || null,
    contextWindow,
    reasoningEffort,
    JSON.stringify(toolNames),
    0, // is_builtin
    0, // is_conductor
    1,
    now,
    now
  );

  const agent = getAgent(id);
  if (!agent) throw new Error("Agent insert failed.");
  return agent;
}

export function updateAgent(agentId: string, input: UpdateAgentInput): Agent | null {
  const existing = getAgent(agentId);
  if (!existing) return null;
  const db = getDatabase();
  const now = Date.now();

  const name = input.name?.trim() || existing.name;
  const avatar = input.avatar ?? existing.avatar;
  const description = input.description ?? existing.description;
  const capabilities = input.capabilities ?? existing.capabilities;
  const systemPrompt = input.systemPrompt ?? existing.systemPrompt;
  const modelProvider = input.modelProvider !== undefined ? input.modelProvider : existing.modelProvider;
  const modelId = input.modelId !== undefined ? (input.modelId?.trim() || null) : existing.modelId;
  const apiKey = input.apiKey !== undefined ? (input.apiKey?.trim() || null) : existing.apiKey;
  const apiBaseUrl = input.apiBaseUrl !== undefined ? (input.apiBaseUrl?.trim() || null) : existing.apiBaseUrl;
  const contextWindow = input.contextWindow !== undefined ? validateContextWindow(input.contextWindow) : existing.contextWindow;
  const reasoningEffort = input.reasoningEffort !== undefined ? validateReasoningEffort(input.reasoningEffort) : existing.reasoningEffort;

  const adapterName = input.adapterName ?? existing.adapterName;
  // Retired rows keep today's exact migration error until the caller explicitly
  // picks a selectable engine; `opencode` is a selectable name even when its
  // driver is not installed, so it can be saved and then fails at run time.
  if (!isSelectableAdapter(adapterName)) {
    if (isRetiredAdapter(adapterName)) {
      throw new Error("Choose Pi and configure a provider to migrate this retired Agent.");
    }
    throw new Error(unregisteredHarnessFailure(adapterName).message);
  }
  const toolNames = input.toolNames ?? existing.toolNames;
  const executionChanged = JSON.stringify([adapterName, modelProvider, modelId, apiKey, apiBaseUrl, contextWindow, reasoningEffort, systemPrompt, toolNames]) !==
    JSON.stringify([existing.adapterName, existing.modelProvider, existing.modelId, existing.apiKey, existing.apiBaseUrl, existing.contextWindow, existing.reasoningEffort, existing.systemPrompt, existing.toolNames]);
  const active = db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE agent_id=? AND status IN ('queued','running')").get(agentId) as { count: number };
  if (executionChanged && active.count > 0) throw new Error("Stop the Agent's active runs before changing its execution configuration.");
  validateCustomAgentConfig(
    adapterName,
    modelProvider,
    modelId,
    apiKey,
    apiBaseUrl
  );

  db.prepare(`
    UPDATE agents SET
      name = ?, avatar = ?, description = ?, capabilities = ?, system_prompt = ?,
      adapter_name = ?, model_provider = ?, model_id = ?, api_key = ?, api_base_url = ?,
      context_window = ?, reasoning_effort = ?,
      tool_names = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name, avatar, description, JSON.stringify(capabilities),
    systemPrompt, adapterName, modelProvider, modelId, apiKey, apiBaseUrl,
    contextWindow, reasoningEffort,
    JSON.stringify(toolNames), now, agentId
  );

  return getAgent(agentId);
}

function validateCustomAgentConfig(
  adapterName: AdapterName,
  modelProvider: ModelProvider | null,
  modelId: string | null | undefined,
  apiKey: string | null | undefined,
  apiBaseUrl: string | null | undefined
) {
  if (!isSelectableAdapter(adapterName)) {
    if (isRetiredAdapter(adapterName)) throw new Error("The selected execution engine has been retired.");
    throw new Error(unregisteredHarnessFailure(adapterName).message);
  }
  // A selectable-but-not-installed engine (`opencode`) still records the same
  // provider/model configuration: the platform's model resolution is
  // harness-neutral, so a future driver must not need a second config shape.
  // Pi's messages stay byte-identical; another engine names itself honestly.
  const engine = adapterName === "pi" ? "Pi" : harnessDescriptor(adapterName).label;
  // No tool-name validation: `toolNames` no longer authorizes anything (see
  // pi/tool-surface.ts). Rejecting retired or unknown names here would only
  // prevent an Agent whose stored record is stale from being edited at all.
  if (!modelProvider) {
    throw new Error(`${engine} Agents must specify a model provider.`);
  }
  if (!modelId?.trim()) {
    throw new Error(`${engine} Agents must specify a model ID.`);
  }
  if (modelProvider === "openai-compatible") {
    if (!apiKey?.trim()) {
      throw new Error("OpenAI-compatible agents must specify an API key.");
    }
    if (!apiBaseUrl?.trim()) {
      throw new Error("OpenAI-compatible agents must specify an API base URL.");
    }
  }
  if (modelProvider.startsWith("profile:")) requireModelProviderProfile(modelProvider);
}

/** A window is a positive integer; null means "provider default". */
function validateContextWindow(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1_000 || value > 10_000_000) {
    throw new Error("Context window must be an integer between 1,000 and 10,000,000 tokens, or left empty for the provider default.");
  }
  return value;
}

function validateReasoningEffort(value: ReasoningEffort | null | undefined): ReasoningEffort | null {
  if (value === null || value === undefined) return null;
  if (value !== "low" && value !== "medium" && value !== "high") {
    throw new Error("Reasoning effort must be low, medium or high, or left empty.");
  }
  return value;
}

export function deleteAgent(agentId: string): boolean {
  const existing = getAgent(agentId);
  if (!existing) return false;
  if (existing.isBuiltin) {
    throw new Error("Built-in agents cannot be deleted.");
  }

  const db = getDatabase();
  const result = db.prepare("DELETE FROM agents WHERE id = ?").run(agentId) as { changes?: number };
  return (result.changes ?? 0) > 0;
}
