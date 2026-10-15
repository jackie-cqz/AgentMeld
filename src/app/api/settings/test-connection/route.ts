import { z } from "zod";
import { getSettings, resolveApiKey } from "@/server/settings-service";
import { modelProviderSchema, providerBaseUrlSchema } from "@/shared/model-provider-schema";
import { findProviderPreset } from "@/shared/provider-presets";
import { resolveProviderBaseUrl } from "@/server/provider-endpoints";

export const dynamic = "force-dynamic";

const testSchema = z.object({
  provider: modelProviderSchema.refine(value => value !== "anthropic"),
  presetId: z.string().max(80).optional(),
  modelId: z.string().trim().min(1).max(120).optional(),
  apiKey: z.string().trim().min(1).max(300).optional(),
  apiBaseUrl: providerBaseUrlSchema.optional()
});

const PROVIDER_DEFAULTS = {
  deepseek: {
    modelId: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1"
  },
  openai: {
    modelId: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1"
  },
  "volcano-ark": {
    modelId: "doubao-seed-2-0-lite-260428",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3"
  }
} as const;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = testSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false, error: "连接测试参数无效。" }, { status: 400 });
  }

  const settings = getSettings();
  const preset = findProviderPreset(parsed.data.presetId);
  if (parsed.data.presetId && !preset) return Response.json({ ok: false, error: "未知的供应商预设。" }, { status: 400 });
  let apiKey: string | null;
  let resolvedBaseUrl: string | undefined;
  try {
    apiKey = resolveApiKey(parsed.data.provider, parsed.data.apiKey ?? null, settings)
      ?? (parsed.data.provider === "openai-compatible" && preset?.envKey ? process.env[preset.envKey]?.trim() || null : null);
    resolvedBaseUrl = resolveProviderBaseUrl(parsed.data.provider, parsed.data.apiBaseUrl);
  } catch {
    return Response.json({ ok: false, error: "供应商配置不存在。" }, { status: 400 });
  }
  if (!apiKey) {
    return Response.json({
      ok: false,
      error: `缺少 ${parsed.data.provider} API Key。`
    }, { status: 400 });
  }

  const defaults = PROVIDER_DEFAULTS[parsed.data.provider as keyof typeof PROVIDER_DEFAULTS];
  const modelId = parsed.data.modelId ?? defaults?.modelId;
  const baseUrl = resolvedBaseUrl?.replace(/\/+$/, "");
  if (!baseUrl || !modelId) return Response.json({ ok: false, error: "请指定 API 地址和测试模型。" }, { status: 400 });
  const startedAt = performance.now();

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 4,
        temperature: 0
      }),
      signal: AbortSignal.timeout(15_000)
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return Response.json({
        ok: false,
        latencyMs,
        error: `HTTP ${response.status}${detail ? `: ${detail.split(apiKey).join("[redacted]").slice(0, 180)}` : ""}`
      }, { status: 502 });
    }

    return Response.json({
      ok: true,
      latencyMs,
      provider: parsed.data.provider,
      modelId
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : "连接测试失败。"
    }, { status: 502 });
  }
}
