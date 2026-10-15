// Editable Chat Completions starter templates adapted from DeepSeek-Reasonix.
// Attribution and license: THIRD_PARTY_NOTICES.md. Model availability is provider-dependent.
export interface ProviderPreset {
  id: string;
  name: string;
  group: "官方 API" | "Coding Plan" | "聚合平台" | "自定义";
  region: string;
  baseUrl: string;
  models: readonly string[];
  envKey?: string;
}

const kimi = ["kimi-k2.7-code", "kimi-k3", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5"];
const mimo = ["mimo-v2.5-pro", "mimo-v2.5"];
const minimax = ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"];
const glm = ["glm-5.2", "glm-5.1", "glm-5", "glm-5-turbo", "glm-5v-turbo", "glm-4.7", "glm-4.7-flash", "glm-4.7-flashx", "glm-4.6", "glm-4.5", "glm-4.5-air", "glm-4.5-flash"];
const qwen = ["qwen3.7-plus", "qwen3.7-max", "qwen3.6-plus", "qwen3.5-plus", "qwen3-max-2026-01-23", "qwen3-coder-next", "qwen3-coder-plus", "MiniMax-M2.5", "glm-5", "glm-4.7", "kimi-k2.5"];
const qwenPlan = ["qwen3.7-plus", "qwen3.6-plus", "kimi-k2.5", "glm-5", "MiniMax-M2.5", "qwen3.5-plus", "qwen3-max-2026-01-23", "qwen3-coder-next", "qwen3-coder-plus", "glm-4.7"];
const step = ["step-3.7-flash", "step-3.5-flash", "step-3.5-flash-2603"];

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: "glm-cn", name: "智谱 GLM", group: "官方 API", region: "国内", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: glm, envKey: "GLM_API_KEY" },
  { id: "zai-global", name: "Z.AI", group: "官方 API", region: "国际", baseUrl: "https://api.z.ai/api/paas/v4", models: glm, envKey: "ZAI_API_KEY" },
  { id: "kimi-cn", name: "Kimi / Moonshot", group: "官方 API", region: "国内", baseUrl: "https://api.moonshot.cn/v1", models: kimi, envKey: "KIMI_API_KEY" },
  { id: "kimi-global", name: "Kimi / Moonshot", group: "官方 API", region: "国际", baseUrl: "https://api.moonshot.ai/v1", models: kimi, envKey: "MOONSHOT_API_KEY" },
  { id: "qwen-cn", name: "通义千问 Qwen", group: "官方 API", region: "国内", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: qwen, envKey: "QWEN_API_KEY" },
  { id: "qwen-global", name: "通义千问 Qwen", group: "官方 API", region: "国际", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", models: qwen, envKey: "QWEN_API_KEY" },
  { id: "minimax-cn-api", name: "MiniMax", group: "官方 API", region: "国内", baseUrl: "https://api.minimaxi.com/v1", models: minimax, envKey: "MINIMAX_API_KEY" },
  { id: "minimax-global-api", name: "MiniMax", group: "官方 API", region: "国际", baseUrl: "https://api.minimax.io/v1", models: minimax, envKey: "MINIMAX_API_KEY" },
  { id: "mimo-api", name: "小米 MiMo", group: "官方 API", region: "全球", baseUrl: "https://api.xiaomimimo.com/v1", models: mimo, envKey: "MIMO_API_KEY" },
  { id: "longcat-openai", name: "LongCat", group: "官方 API", region: "全球", baseUrl: "https://api.longcat.chat/openai/v1", models: ["LongCat-2.0"], envKey: "LONGCAT_API_KEY" },
  { id: "stepfun-api", name: "阶跃星辰 StepFun", group: "官方 API", region: "按量计费", baseUrl: "https://api.stepfun.com/v1", models: step, envKey: "STEPFUN_API_KEY" },
  { id: "glm-coding-plan-cn", name: "智谱 GLM Coding Plan", group: "Coding Plan", region: "国内", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", models: ["glm-5.2", "glm-5.1", "glm-5", "glm-4.7"], envKey: "GLM_PLAN_API_KEY" },
  { id: "zai-coding-plan-global", name: "Z.AI Coding Plan", group: "Coding Plan", region: "国际", baseUrl: "https://api.z.ai/api/coding/paas/v4", models: ["glm-5.2", "glm-5.1", "glm-5", "glm-4.7"], envKey: "ZAI_CODING_API_KEY" },
  { id: "qwen-coding-plan-cn", name: "Qwen Coding Plan", group: "Coding Plan", region: "国内", baseUrl: "https://coding.dashscope.aliyuncs.com/v1", models: qwenPlan, envKey: "QWEN_CODING_API_KEY" },
  { id: "qwen-coding-plan-global", name: "Qwen Coding Plan", group: "Coding Plan", region: "国际", baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1", models: qwenPlan, envKey: "QWEN_CODING_API_KEY" },
  { id: "mimo-token-plan-cn", name: "MiMo Token Plan", group: "Coding Plan", region: "中国", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", models: mimo, envKey: "MIMO_TOKEN_PLAN_API_KEY" },
  { id: "mimo-token-plan-sgp", name: "MiMo Token Plan", group: "Coding Plan", region: "新加坡", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", models: mimo, envKey: "MIMO_TOKEN_PLAN_API_KEY" },
  { id: "mimo-token-plan-ams", name: "MiMo Token Plan", group: "Coding Plan", region: "阿姆斯特丹", baseUrl: "https://token-plan-ams.xiaomimimo.com/v1", models: mimo, envKey: "MIMO_TOKEN_PLAN_API_KEY" },
  { id: "stepfun", name: "阶跃星辰 Step Plan", group: "Coding Plan", region: "套餐", baseUrl: "https://api.stepfun.com/step_plan/v1", models: step, envKey: "STEPFUN_API_KEY" },
  { id: "opencode-go", name: "OpenCode Go", group: "Coding Plan", region: "Chat Completions", baseUrl: "https://opencode.ai/zen/go/v1", models: ["glm-5.2", "glm-5.3", "glm-5.1", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "deepseek-v4-pro", "deepseek-v4-flash", "mimo-v2.5-pro", "mimo-v2.5", "hy3"], envKey: "OPENCODE_GO_API_KEY" },
  { id: "scnet", name: "国家超算互联网 SCNet", group: "Coding Plan", region: "国内", baseUrl: "https://api.scnet.cn/api/llm/v1", models: ["MiniMax-M2.5", "GLM-5.2", "GLM-5", "GLM-5.1", "Kimi-K3", "Kimi-K2.7-Code", "Kimi-K2.6", "Kimi-K2.5", "DeepSeek-V4-Flash", "DeepSeek-V3.2", "MiniMax-M3", "MiniMax-M2.7", "MiMo-V2.5-Pro"], envKey: "SCNET_API_KEY" },
  { id: "token-rhythm", name: "基元律动 Token Rhythm", group: "聚合平台", region: "全球", baseUrl: "https://tokenrhythm.studio/v1", models: ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5.2", "glm-5.1", "glm-5", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "minimax-m2.7", "minimax-m2.5", "mimo-v2.5-pro", "qwen3.7-max", "qwen3.8-max", "deepseek-v4-flash-0731"], envKey: "TOKEN_RHYTHM_API_KEY" },
  { id: "novita", name: "NovitaAI", group: "聚合平台", region: "全球", baseUrl: "https://api.novita.ai/openai/v1", models: ["zai-org/glm-5.2", "moonshotai/kimi-k2.7-code", "minimax/minimax-m3", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash", "qwen/qwen3.7-max", "qwen/qwen3.6-plus", "zai-org/glm-5v-turbo"], envKey: "NOVITA_API_KEY" },
  { id: "gmi", name: "GMI Cloud", group: "聚合平台", region: "全球", baseUrl: "https://api.gmi-serving.com/v1", models: ["zai-org/GLM-5.2-FP8", "deepseek-ai/DeepSeek-V4-Pro", "deepseek-ai/DeepSeek-V4-Flash", "moonshotai/Kimi-K2.7-Code", "anthropic/claude-sonnet-4.6", "openai/gpt-5.5"], envKey: "GMI_API_KEY" },
  { id: "huggingface", name: "Hugging Face Router", group: "聚合平台", region: "全球", baseUrl: "https://router.huggingface.co/v1", models: ["zai-org/GLM-5.2", "deepseek-ai/DeepSeek-V3.2", "Qwen/Qwen3.5-72B-Instruct"], envKey: "HF_TOKEN" },
  { id: "nvidia", name: "NVIDIA NIM", group: "聚合平台", region: "全球", baseUrl: "https://integrate.api.nvidia.com/v1", models: ["nvidia/nemotron-3-nano-30b-a3b", "nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-ultra-550b-a55b", "deepseek-ai/deepseek-v4-pro", "qwen/qwen3.5-397b-a17b"], envKey: "NVIDIA_API_KEY" },
  { id: "kilocode", name: "KiloCode", group: "聚合平台", region: "自动路由", baseUrl: "https://api.kilo.ai/api/gateway", models: ["kilo/auto"], envKey: "KILOCODE_API_KEY" },
  { id: "ollama-cloud", name: "Ollama Cloud", group: "聚合平台", region: "云端", baseUrl: "https://ollama.com/v1", models: ["glm-5.2", "kimi-k2.7-code", "deepseek-v4-pro", "deepseek-v4-flash", "minimax-m3", "nemotron-3-nano:30b", "qwen3-coder-next"], envKey: "OLLAMA_API_KEY" },
  { id: "custom", name: "自定义兼容供应商", group: "自定义", region: "Chat Completions", baseUrl: "", models: [] }
];

export function findProviderPreset(id: string | null | undefined) {
  return PROVIDER_PRESETS.find(preset => preset.id === id);
}

export const profileProviderId = (id: string): `profile:${string}` => `profile:${id}`;
