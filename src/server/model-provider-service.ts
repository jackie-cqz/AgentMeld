import type { z } from "zod";
import { ensureDatabase } from "@/db/bootstrap";
import { getDatabase } from "@/db/client";
import { newModelProviderId } from "@/shared/ids";
import { providerProfileInputSchema } from "@/shared/model-provider-schema";
import { findProviderPreset, profileProviderId } from "@/shared/provider-presets";
import type { ModelProviderProfile } from "@/shared/types";

type ProfileInput = z.infer<typeof providerProfileInputSchema>;
interface ProfileRow {
  id: string; name: string; preset_id: string | null; protocol: string;
  base_url: string; default_model: string; models: string; api_key: string | null;
}

function getProfileRow(id: string): ProfileRow | undefined {
  ensureDatabase();
  return getDatabase().prepare("SELECT * FROM model_provider_profiles WHERE id = ?").get(id) as ProfileRow | undefined;
}

function environmentKey(row: ProfileRow): string | null {
  const env = findProviderPreset(row.preset_id)?.envKey;
  return env ? process.env[env]?.trim() || null : null;
}

function publicProfile(row: ProfileRow): ModelProviderProfile {
  const count = getDatabase().prepare("SELECT COUNT(*) AS total FROM agents WHERE model_provider = ?").get(profileProviderId(row.id)) as { total: number };
  return { id: row.id, name: row.name, presetId: row.preset_id, protocol: "chat-completions",
    baseUrl: row.base_url, defaultModel: row.default_model, models: JSON.parse(row.models) as string[],
    credentialSource: row.api_key ? "app_settings" : environmentKey(row) ? "environment" : "missing", agentCount: count.total };
}

export function listModelProviderProfiles(): ModelProviderProfile[] {
  ensureDatabase();
  const rows = getDatabase().prepare("SELECT * FROM model_provider_profiles ORDER BY created_at, id").all() as ProfileRow[];
  return rows.map(publicProfile);
}

// Only the server-side resolver receives credentials; APIs return publicProfile instead.
export function requireModelProviderProfile(provider: string) {
  const id = provider.startsWith("profile:") ? provider.slice(8) : provider;
  const row = getProfileRow(id);
  if (!row || row.protocol !== "chat-completions") throw new Error("供应商配置不存在或协议不受支持，请重新选择模型供应商。");
  return { baseUrl: row.base_url, apiKey: row.api_key || environmentKey(row), defaultModel: row.default_model };
}

export function saveModelProviderProfile(input: ProfileInput, id?: string): ModelProviderProfile {
  const value = providerProfileInputSchema.parse(input);
  ensureDatabase();
  const existing = id ? getProfileRow(id) : undefined;
  if (id && !existing) throw new Error("供应商配置不存在。");
  if (value.presetId && !findProviderPreset(value.presetId)) throw new Error("未知的供应商预设。");
  if (existing && existing.preset_id !== value.presetId) throw new Error("不能更换已有配置的预设，请添加新供应商。");
  const apiKey = value.apiKey ?? existing?.api_key ?? null;
  const env = findProviderPreset(value.presetId)?.envKey;
  if (!apiKey && !(env && process.env[env]?.trim())) throw new Error("请填写 API Key，或配置对应的环境变量。");
  const profileId = id ?? newModelProviderId();
  const models = [...new Set([value.defaultModel, ...value.models])];
  if (models.length > 100) throw new Error("包含默认模型在内，模型列表最多 100 项。");
  const now = Date.now();
  getDatabase().prepare(`
    INSERT INTO model_provider_profiles (id, name, preset_id, protocol, base_url, default_model, models, api_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url, default_model=excluded.default_model,
      models=excluded.models, api_key=excluded.api_key, updated_at=excluded.updated_at
  `).run(profileId, value.name, value.presetId, value.protocol, value.baseUrl.replace(/\/+$/, ""), value.defaultModel, JSON.stringify(models), apiKey, now, now);
  return publicProfile(getProfileRow(profileId)!);
}

export function deleteModelProviderProfile(id: string): void {
  ensureDatabase();
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const profile = getProfileRow(id);
    if (!profile) throw new Error("供应商配置不存在。");
    if (publicProfile(profile).agentCount > 0) throw new Error("仍有 Agent 使用此供应商，请先更换这些 Agent 的模型供应商。");
    db.prepare("DELETE FROM model_provider_profiles WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
