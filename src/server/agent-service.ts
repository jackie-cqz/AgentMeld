import { getDatabase } from "@/db/client";
import { listAgents, getAgent } from "@/server/repositories";
import { newAgentId } from "@/shared/ids";
import { TOOL_PRESETS, ALL_TOOL_NAMES, DEFAULT_CUSTOM_PROMPT } from "@/shared/agent-constants";
import type { AdapterName, Agent, ModelProvider } from "@/shared/types";

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
  return listAgents();
}

export function createAgent(input: CreateAgentInput): Agent {
  const db = getDatabase();
  const id = newAgentId();
  const now = Date.now();

  // Adapter-specific defaults
  const adapterName = input.adapterName;
  const isClaudeCodeOrCodex = adapterName === "claude-code" || adapterName === "codex";
  const toolNames = isClaudeCodeOrCodex
    ? [] // SDK adapters use their own tool sets
    : (input.toolNames ?? TOOL_PRESETS["all-purpose"].tools);

  const modelProvider = isClaudeCodeOrCodex
    ? (adapterName === "claude-code" ? "anthropic" : null)
    : (input.modelProvider ?? "deepseek");

  // Validate: custom adapter must have model
  if (adapterName === "custom" && !input.modelId?.trim()) {
    throw new Error("Custom agents must specify a model ID.");
  }
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
    adapterName === "custom" ? 1 : 0, // supports_vision (custom agents default to yes)
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

  // SDK adapters force empty toolNames
  const isSdk = existing.adapterName === "claude-code" || existing.adapterName === "codex";
  const toolNames = isSdk ? [] : (input.toolNames ?? existing.toolNames);
  validateCustomAgentConfig(
    existing.adapterName,
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
      model_provider = ?, model_id = ?, api_key = ?, api_base_url = ?,
      tool_names = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name, avatar, description, JSON.stringify(capabilities),
    systemPrompt, modelProvider, modelId, apiKey, apiBaseUrl,
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
  if (adapterName !== "custom") return;
  if (!modelProvider) {
    throw new Error("Custom agents must specify a model provider.");
  }
  if (!modelId?.trim()) {
    throw new Error("Custom agents must specify a model ID.");
  }
  if (modelProvider === "openai-compatible") {
    if (!apiKey?.trim()) {
      throw new Error("OpenAI-compatible agents must specify an API key.");
    }
    if (!apiBaseUrl?.trim()) {
      throw new Error("OpenAI-compatible agents must specify an API base URL.");
    }
  }
  const allowedTools = allowInternalTools
    ? new Set([...ALL_TOOL_NAMES, "plan_tasks", "report_task_result"])
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
