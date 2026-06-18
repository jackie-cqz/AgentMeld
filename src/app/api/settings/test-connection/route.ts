import { z } from "zod";
import { getSettings, resolveApiKey } from "@/server/settings-service";

export const dynamic = "force-dynamic";

const testSchema = z.object({
  provider: z.enum(["deepseek", "openai", "volcano-ark"]),
  modelId: z.string().trim().min(1).max(120).optional(),
  apiKey: z.string().trim().min(1).max(300).optional(),
  apiBaseUrl: z.string().trim().url().max(500).optional()
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
  const apiKey = resolveApiKey(parsed.data.provider, parsed.data.apiKey ?? null, settings);
  if (!apiKey) {
    return Response.json({
      ok: false,
      error: `缺少 ${parsed.data.provider} API Key。`
    }, { status: 400 });
  }

  const defaults = PROVIDER_DEFAULTS[parsed.data.provider];
  const baseUrl = (parsed.data.apiBaseUrl ?? defaults.baseUrl).replace(/\/+$/, "");
  const startedAt = performance.now();

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: parsed.data.modelId ?? defaults.modelId,
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
        error: `HTTP ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`
      }, { status: 502 });
    }

    return Response.json({
      ok: true,
      latencyMs,
      provider: parsed.data.provider,
      modelId: parsed.data.modelId ?? defaults.modelId
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : "连接测试失败。"
    }, { status: 502 });
  }
}
