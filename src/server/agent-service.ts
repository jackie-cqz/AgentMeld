import { ensureDatabase } from "@/db/bootstrap";
import { getDatabase } from "@/db/client";
import { listAgents, getAgent } from "@/server/repositories";
import { newAgentId } from "@/shared/ids";
import { TOOL_PRESETS, ALL_TOOL_NAMES, DEFAULT_CUSTOM_PROMPT, PI_RETIRED_TOOLS } from "@/shared/agent-constants";
import type { AdapterName, Agent, ModelProvider } from "@/shared/types";
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
  systemPrompt?: string;
  toolNames?: string[];
}

export interface UpdateAgentInput {
  adapterName?: "pi";
  name?: string;
  avatar?: string;
  description?: string;
  capabilities?: string[];
  modelProvider?: ModelProvider | null;
  modelId?: string | null;
  apiKey?: string | null;
  apiBaseUrl?: string | null;
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

export function createAgent(input: CreateAgentInput): Agent {
  const db = getDatabase();
  const id = newAgentId();
  const now = Date.now();

  if (input.adapterName !== "pi") throw new Error("New Agents must use the Pi execution engine.");
  const adapterName = "pi";
  const toolNames = input.toolNames ?? TOOL_PRESETS["all-purpose"].tools;
  const modelProvider = input.modelProvider ?? "deepseek";
  validateCustomAgentConfig(adapterName, modelProvider, input.modelId, input.apiKey, input.apiBaseUrl, toolNames, false);

  db.prepare(`
    INSERT INTO agents (
      id, name, avatar, description, capabilities, system_prompt,
      adapter_name, model_provider, model_id, api_key, api_base_url,
      tool_names, is_builtin, is_conductor, supports_vision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  const adapterName = input.adapterName ?? existing.adapterName;
  if (adapterName !== "pi") throw new Error("Choose Pi and configure a provider to migrate this retired Agent.");
  const toolNames = input.toolNames ?? existing.toolNames;
  const executionChanged = JSON.stringify([adapterName, modelProvider, modelId, apiKey, apiBaseUrl, systemPrompt, toolNames]) !==
    JSON.stringify([existing.adapterName, existing.modelProvider, existing.modelId, existing.apiKey, existing.apiBaseUrl, existing.systemPrompt, existing.toolNames]);
  const active = db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE agent_id=? AND status IN ('queued','running')").get(agentId) as { count: number };
  if (executionChanged && active.count > 0) throw new Error("Stop the Agent's active runs before changing its execution configuration.");
  validateCustomAgentConfig(
    adapterName,
    modelProvider,
    modelId,
    apiKey,
    apiBaseUrl,
    toolNames,
    existing.isBuiltin
  );

  db.prepare(`
    UPDATE agents SET
      name = ?, avatar = ?, description = ?, capabilities = ?, system_prompt = ?,
      adapter_name = ?, model_provider = ?, model_id = ?, api_key = ?, api_base_url = ?,
      tool_names = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name, avatar, description, JSON.stringify(capabilities),
    systemPrompt, adapterName, modelProvider, modelId, apiKey, apiBaseUrl,
    JSON.stringify(toolNames), now, agentId
  );

  return getAgent(agentId);
}

function validateCustomAgentConfig(
  adapterName: AdapterName,
  modelProvider: ModelProvider | null,
  modelId: string | null | undefined,
  apiKey: string | null | undefined,
  apiBaseUrl: string | null | undefined,
  toolNames: readonly string[],
  allowInternalTools: boolean
) {
  if (adapterName !== "pi") throw new Error("The selected execution engine has been retired.");
  if (toolNames.some(name => PI_RETIRED_TOOLS.includes(name))) throw new Error("Pi uses native bash for verification. Remove retired job_* tool grants.");
  if (!modelProvider) {
    throw new Error("Pi Agents must specify a model provider.");
  }
  if (!modelId?.trim()) {
    throw new Error("Pi Agents must specify a model ID.");
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
  const allowedTools = allowInternalTools
    ? new Set([...ALL_TOOL_NAMES, "plan_tasks", "report_task_result", "update_context_facts"])
    : new Set<string>(ALL_TOOL_NAMES);
  const unknownTools = toolNames.filter((toolName) => !allowedTools.has(toolName));
  if (unknownTools.length > 0) {
    throw new Error(`Unknown Agent tools: ${unknownTools.join(", ")}.`);
  }
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
