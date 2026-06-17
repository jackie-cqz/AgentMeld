import { getDatabase } from "@/db/client";
import type { AppSettings, CompanionMode } from "@/shared/types";

export function getSettings(): AppSettings {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM app_settings WHERE id = 'singleton'").get() as Record<string, unknown> | undefined;

  if (!row) {
    // Bootstrap if missing (shouldn't happen with ensureDatabase)
    const now = Date.now();
    db.prepare(`
      INSERT INTO app_settings (id, companion_mode, deployment_publish_enabled, created_at, updated_at)
      VALUES ('singleton', 'off', 0, ?, ?)
    `).run(now, now);
    return getSettings();
  }

  return mapRow(row);
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings();
  const db = getDatabase();
  const now = Date.now();

  const updated: AppSettings = {
    ...current,
    ...patch,
    updatedAt: now
  };

  db.prepare(`
    UPDATE app_settings SET
      anthropic_api_key = ?, anthropic_base_url = ?,
      openai_api_key = ?, deepseek_api_key = ?, ark_api_key = ?,
      companion_mode = ?, mobile_device_token = ?,
      deployment_publish_enabled = ?, deployment_publish_dir = ?,
      deployment_public_base_url = ?,
      updated_at = ?
    WHERE id = 'singleton'
  `).run(
    normalizeKey(updated.anthropicApiKey),
    updated.anthropicBaseUrl ?? null,
    normalizeKey(updated.openaiApiKey),
    normalizeKey(updated.deepseekApiKey),
    normalizeKey(updated.arkApiKey),
    updated.companionMode,
    updated.mobileDeviceToken ?? null,
    updated.deploymentPublishEnabled ? 1 : 0,
    updated.deploymentPublishDir ?? null,
    updated.deploymentPublicBaseUrl ?? null,
    now
  );

  return updated;
}

/**
 * Resolve API key for a given provider.
 * Priority: agent.api_key → app_settings.<provider>_api_key → process.env
 */
export function resolveApiKey(
  provider: string,
  agentApiKey: string | null,
  settings: AppSettings
): string | null {
  // 1. Per-agent override
  if (agentApiKey) return agentApiKey;

  // 2. Global settings
  const settingKey = providerToSettingKey(provider);
  if (settingKey) {
    const value = settings[settingKey];
    if (value) return value as string;
  }

  // 3. Environment variable
  const envKey = providerToEnvKey(provider);
  if (envKey && process.env[envKey]) return process.env[envKey]!;

  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeKey(value: string | null | undefined): string | null {
  if (!value || value.trim() === "") return null;
  return value.trim();
}

function providerToSettingKey(provider: string): keyof AppSettings | null {
  switch (provider) {
    case "openai": return "openaiApiKey";
    case "deepseek": return "deepseekApiKey";
    case "volcano-ark": return "arkApiKey";
    case "anthropic": return "anthropicApiKey";
    default: return null;
  }
}

function providerToEnvKey(provider: string): string | null {
  switch (provider) {
    case "openai": return "OPENAI_API_KEY";
    case "deepseek": return "DEEPSEEK_API_KEY";
    case "volcano-ark": return "ARK_API_KEY";
    case "anthropic": return "ANTHROPIC_API_KEY";
    default: return null;
  }
}

function mapRow(row: Record<string, unknown>): AppSettings {
  return {
    id: "singleton",
    anthropicApiKey: (row.anthropic_api_key as string) ?? null,
    anthropicBaseUrl: (row.anthropic_base_url as string) ?? null,
    openaiApiKey: (row.openai_api_key as string) ?? null,
    deepseekApiKey: (row.deepseek_api_key as string) ?? null,
    arkApiKey: (row.ark_api_key as string) ?? null,
    companionMode: (row.companion_mode as CompanionMode) ?? "off",
    mobileDeviceToken: (row.mobile_device_token as string) ?? null,
    deploymentPublishEnabled: (row.deployment_publish_enabled as number) === 1,
    deploymentPublishDir: (row.deployment_publish_dir as string) ?? null,
    deploymentPublicBaseUrl: (row.deployment_public_base_url as string) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number
  };
}
