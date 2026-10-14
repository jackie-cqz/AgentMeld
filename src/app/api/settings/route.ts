import { z } from "zod";
import { getApiKeySources, getSettings, updateSettings } from "@/server/settings-service";
import type { AppSettings } from "@/shared/types";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  anthropicApiKey: z.string().nullable().optional(),
  anthropicBaseUrl: z.string().nullable().optional(),
  openaiApiKey: z.string().nullable().optional(),
  deepseekApiKey: z.string().nullable().optional(),
  arkApiKey: z.string().nullable().optional(),
  companionMode: z.enum(["off", "lan", "tailnet"]).optional(),
  deploymentPublishEnabled: z.boolean().optional(),
  deploymentPublishDir: z.string().nullable().optional(),
  deploymentPublicBaseUrl: z.string().nullable().optional()
});

export async function GET() {
  const settings = getSettings();
  return Response.json({ settings: maskSettings(settings), keySources: getApiKeySources(settings) });
}

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const updated = updateSettings(removeMaskedKeys(parsed.data));
  return Response.json({ settings: maskSettings(updated) });
}

// Never return raw API keys from the API — GET and PATCH must both mask.
function maskSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    anthropicApiKey: maskKey(settings.anthropicApiKey),
    openaiApiKey: maskKey(settings.openaiApiKey),
    deepseekApiKey: maskKey(settings.deepseekApiKey),
    arkApiKey: maskKey(settings.arkApiKey)
  };
}

function maskKey(key: string | null): string | null {
  if (!key || key.length <= 4) return key;
  return "*".repeat(key.length - 4) + key.slice(-4);
}

export function removeMaskedKeys<T extends Record<string, unknown>>(patch: T): T {
  const next = { ...patch };
  for (const key of ["anthropicApiKey", "openaiApiKey", "deepseekApiKey", "arkApiKey"] as const) {
    const value = next[key];
    if (typeof value === "string" && /^\*+[^*]{0,4}$/.test(value)) {
      delete next[key];
    }
  }
  return next;
}
