import { z } from "zod";

export const providerProfileIdSchema = z.string().regex(/^mp_[A-Za-z0-9_-]{12}$/);
export const modelProviderSchema = z.union([
  z.enum(["openai", "deepseek", "volcano-ark", "anthropic", "openai-compatible"]),
  z.string().regex(/^profile:mp_[A-Za-z0-9_-]{12}$/).transform(value => value as `profile:${string}`)
]);

export const providerBaseUrlSchema = z.string().trim().url("请输入有效的 API 地址。").max(500).refine(value => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, "API 地址必须使用 HTTP/HTTPS，且不能包含凭据、查询参数或片段。");

export const providerProfileInputSchema = z.object({
  name: z.string().trim().min(1, "请输入配置名称。").max(80, "配置名称最多 80 个字符。"),
  presetId: z.string().max(80).nullable(),
  protocol: z.literal("chat-completions"),
  baseUrl: providerBaseUrlSchema,
  defaultModel: z.string().trim().min(1, "请输入默认模型 ID。").max(100, "模型 ID 最多 100 个字符。"),
  models: z.array(z.string().trim().min(1).max(100)).max(100),
  apiKey: z.string().trim().min(1).max(300).refine(value => !/[\r\n]/.test(value), "API Key 不能包含换行。").optional()
}).strict();
