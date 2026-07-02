"use client";

import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Cpu,
  Eye,
  EyeOff,
  SlidersHorizontal,
  Sparkles,
  User,
  Wrench
} from "lucide-react";
import type { AdapterName, ModelProvider } from "@/shared/types";
import {
  DEFAULT_CUSTOM_PROMPT,
  TOOL_PRESETS,
  type ToolPresetName
} from "@/shared/agent-constants";

const TOOL_GROUPS = [
  { label: "只读", tone: "safe", tools: ["fs_list", "fs_read", "read_artifact", "read_attachment"] as const },
  { label: "文件写入", tone: "danger", tools: ["fs_write"] as const },
  { label: "命令执行", tone: "danger", tools: ["bash"] as const },
  { label: "Artifact", tone: "safe", tools: ["write_artifact"] as const },
  { label: "部署", tone: "danger", tools: ["deploy_artifact", "deploy_workspace"] as const },
  { label: "用户交互", tone: "safe", tools: ["ask_user"] as const },
];

const TOOL_META: Record<string, { label: string; description: string }> = {
  fs_list: { label: "列出文件", description: "查看工作区目录结构" },
  fs_read: { label: "读取文件", description: "读取工作区文本内容" },
  fs_write: { label: "写入文件", description: "可修改工作区文件，需要谨慎授权" },
  bash: { label: "执行命令", description: "可运行构建与测试命令，属于高风险权限" },
  read_artifact: { label: "读取产物", description: "读取上游 Agent 产物" },
  write_artifact: { label: "创建产物", description: "生成可检查的文档或 Web App" },
  deploy_artifact: { label: "部署产物", description: "发布 Web App 产物" },
  deploy_workspace: { label: "部署工作区", description: "发布工作区构建结果" },
  read_attachment: { label: "读取附件", description: "读取用户上传的附件" },
  ask_user: { label: "询问用户", description: "需求不明确时发起结构化提问" }
};

const PROVIDER_DEFAULT_MODELS: Partial<Record<ModelProvider, string>> = {
  deepseek: "deepseek-chat",
  openai: "gpt-4o",
  "volcano-ark": "doubao-seed-2-0-lite-260428",
  "openai-compatible": ""
};

type AgentEditTab = "basic" | "model" | "tools";
type CreateStage = "choice" | "quick" | "detailed";

interface CreateAgentDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (payload: {
    name: string;
    description: string;
    capabilities?: string[];
    adapterName: AdapterName;
    modelProvider?: ModelProvider | null;
    modelId?: string | null;
    apiKey?: string | null;
    apiBaseUrl?: string | null;
    systemPrompt?: string;
    toolNames?: string[];
  }) => Promise<void>;
  // Edit mode: pre-fill form with existing agent data
  initial?: {
    name: string;
    description: string;
    capabilities: string[];
    adapterName: AdapterName;
    modelProvider: ModelProvider | null;
    modelId: string | null;
    apiKey: string | null;
    apiBaseUrl: string | null;
    systemPrompt: string;
    toolNames: string[];
  };
}

export function CreateAgentDialog({ open, onClose, onCreate, initial }: CreateAgentDialogProps) {
  const isEdit = !!initial;
  const [createStage, setCreateStage] = useState<CreateStage>(isEdit ? "detailed" : "choice");
  const [quickDesc, setQuickDesc] = useState("");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [capabilitiesInput, setCapabilitiesInput] = useState((initial?.capabilities ?? []).join("，"));
  const [adapterName] = useState<AdapterName>(initial?.adapterName ?? "custom");
  const [modelProvider, setModelProvider] = useState<ModelProvider | null>(initial?.modelProvider ?? "deepseek");
  const [modelId, setModelId] = useState(initial?.modelId ?? "deepseek-chat");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [apiBaseUrl, setApiBaseUrl] = useState(initial?.apiBaseUrl ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? DEFAULT_CUSTOM_PROMPT);
  const [toolNames, setToolNames] = useState<string[]>(initial?.toolNames ?? [...TOOL_PRESETS["all-purpose"].tools]);
  const [submitting, setSubmitting] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftBasis, setDraftBasis] = useState<string | null>(null);
  const [editTab, setEditTab] = useState<AgentEditTab>("basic");

  if (!open) return null;

  const isChoice = !isEdit && createStage === "choice";
  const isQuick = !isEdit && createStage === "quick";
  const isDetailed = isEdit || createStage === "detailed";
  const isSdk = adapterName === "claude-code" || adapterName === "codex";
  const isSdkDisabled = true;

  const resetCreateForm = () => {
    if (isEdit) return;
    setCreateStage("choice");
    setQuickDesc("");
    setName("");
    setDescription("");
    setCapabilitiesInput("");
    setModelProvider("deepseek");
    setModelId("deepseek-chat");
    setApiKey("");
    setApiBaseUrl("");
    setSystemPrompt(DEFAULT_CUSTOM_PROMPT);
    setToolNames([...TOOL_PRESETS["all-purpose"].tools]);
    setShowApiKey(false);
    setError(null);
    setDraftBasis(null);
    setEditTab("basic");
  };

  const handleClose = () => {
    resetCreateForm();
    onClose();
  };

  const handleGenerateDraft = () => {
    if (!quickDesc.trim()) return;
    // Simple heuristic: extract intent from description
    const desc = quickDesc.toLowerCase();
    const draft: { name: string; tools: string[]; prompt: string } = {
      name: quickDesc.slice(0, 30).replace(/[，,。.]/g, "").trim() || "新 Agent",
      tools: [...TOOL_PRESETS["all-purpose"].tools],
      prompt: `${DEFAULT_CUSTOM_PROMPT}\n\nSpecialized role:\n${quickDesc}`
    };

    if (desc.includes("前端") || desc.includes("代码") || desc.includes("react") || desc.includes("vue")) {
      draft.name = draft.name || "前端开发";
      draft.tools = ["fs_read", "fs_write", "bash", "write_artifact", "read_artifact"];
      draft.prompt = `You are a frontend developer. Write clean, working code. Use fs_write for source files, bash for build/test, write_artifact for deliverable demos. ${quickDesc}`;
    } else if (desc.includes("审查") || desc.includes("review") || desc.includes("代码审查")) {
      draft.name = draft.name || "代码审查";
      draft.tools = ["fs_list", "fs_read", "read_artifact"];
      draft.prompt = `You are a code reviewer. Read code, check for issues, and provide clear feedback. Use fs_read and read_artifact to access files. ${quickDesc}`;
    } else if (desc.includes("部署") || desc.includes("deploy") || desc.includes("发布")) {
      draft.name = draft.name || "部署助手";
      draft.tools = ["bash", "fs_read", "fs_write", "write_artifact", "deploy_artifact", "deploy_workspace"];
      draft.prompt = `You are a deployment assistant. Build, test, and deploy projects. ${quickDesc}`;
    } else if (desc.includes("文档") || desc.includes("写作") || desc.includes("doc")) {
      draft.name = draft.name || "文档写作";
      draft.tools = ["write_artifact", "read_artifact"];
      draft.prompt = `You are a technical writer. Produce clear, well-structured documents using write_artifact. ${quickDesc}`;
    } else if (desc.includes("研究") || desc.includes("调研") || desc.includes("research")) {
      draft.name = draft.name || "研究分析";
      draft.tools = [...TOOL_PRESETS.research.tools];
      draft.prompt = `${DEFAULT_CUSTOM_PROMPT}\n\n## Specialized role\nYou are a research analyst. Compare evidence, identify uncertainty, and deliver a structured report artifact.\n\nUser role description:\n${quickDesc}`;
    }

    setName(draft.name);
    setDescription(quickDesc.trim());
    setToolNames(draft.tools);
    setSystemPrompt(draft.prompt);
    setDraftBasis(`根据“${quickDesc.trim().slice(0, 80)}”生成；默认使用 DeepSeek、普通协作 Agent，并由你确认工具权限后再保存。`);
    setEditTab("basic");
    setCreateStage("detailed");
  };

  const handlePreset = (presetName: ToolPresetName) => {
    setToolNames([...TOOL_PRESETS[presetName].tools]);
  };

  const capabilities = parseCapabilities(capabilitiesInput);

  const toggleTool = (tool: string) => {
    setToolNames((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]
    );
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setError(null);
    if (!description.trim()) {
      setError("Agent 描述为必填项，会显示在 Agent 卡片中。");
      setEditTab("basic");
      return;
    }
    // Config validation
    if (!isSdk && !modelId?.trim()) {
      setError("Custom 适配器必须指定 Model ID。");
      return;
    }
    if (!isSdk && !modelProvider) {
      setError("Custom 适配器必须指定 Provider。");
      return;
    }
    if (!isSdk && modelProvider === "openai-compatible") {
      if (!apiKey.trim()) {
        setError("OpenAI-Compatible 必须提供 API Key。");
        return;
      }
      if (!apiBaseUrl.trim()) {
        setError("OpenAI-Compatible 必须提供 API Base URL。");
        return;
      }
    }
    setSubmitting(true);
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim(),
        capabilities,
        adapterName,
        modelProvider: isSdk ? undefined : modelProvider,
        modelId: isSdk ? null : (modelId.trim() || null),
        apiKey: apiKey.trim() || null,
        apiBaseUrl: apiBaseUrl.trim() || null,
        systemPrompt: systemPrompt.trim() || undefined,
        toolNames: isSdk ? [] : toolNames
      });
      handleClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "保存 Agent 失败。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/30 px-4">
      <div className={`flex max-h-[90vh] w-full flex-col overflow-hidden rounded-lg border border-stone-200 bg-white shadow-2xl ${isDetailed ? "max-w-lg" : "max-w-md"}`}>
        <div className="min-h-0 flex-1 overflow-y-auto p-6 pb-4">
          {isChoice ? (
            <>
              <h2 className="text-lg font-semibold text-stone-950">新建 Agent</h2>
              <p className="mt-2 text-sm leading-6 text-stone-500">
                选择创建方式。你可以先描述需求生成草稿，也可以直接配置全部信息。
              </p>
              <div className="mt-5 grid gap-3">
                <button
                  type="button"
                  onClick={() => setCreateStage("quick")}
                  className="group flex min-h-28 w-full items-center gap-4 rounded-lg border border-blue-200 bg-blue-50/60 p-4 text-left transition hover:border-[#4264ff] hover:bg-blue-50"
                >
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-[#4264ff] text-white">
                    <Sparkles className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-stone-950">快速创建</span>
                    <span className="mt-1 block text-xs leading-5 text-stone-500">
                      描述 Agent 的职责，自动生成名称、工具权限和系统提示词草稿。
                    </span>
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-blue-400 transition group-hover:translate-x-0.5 group-hover:text-[#2546d8]" />
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setEditTab("basic");
                    setCreateStage("detailed");
                  }}
                  className="group flex min-h-28 w-full items-center gap-4 rounded-lg border border-stone-200 bg-white p-4 text-left transition hover:border-stone-400 hover:bg-stone-50"
                >
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-700">
                    <SlidersHorizontal className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-stone-950">详细配置</span>
                    <span className="mt-1 block text-xs leading-5 text-stone-500">
                      从基本信息开始，逐项配置模型、API、工具权限和系统提示词。
                    </span>
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-stone-400 transition group-hover:translate-x-0.5 group-hover:text-stone-700" />
                </button>
              </div>
            </>
          ) : (
            <>
              {!isEdit ? (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setCreateStage("choice");
                  }}
                  className="mb-3 flex items-center gap-1 text-xs font-medium text-stone-500 hover:text-stone-900"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  返回创建方式
                </button>
              ) : null}
              <h2 className="text-lg font-semibold text-stone-950">
                {isEdit ? "编辑 Agent" : isQuick ? "快速创建" : "详细配置"}
              </h2>
              <p className="mt-2 text-sm leading-6 text-stone-500">
                {isEdit
                  ? "修改这个 Agent 的配置。保存后立即生效，已有的会话也会用新配置回复。"
                  : isQuick
                    ? "先描述你希望 Agent 承担的工作，系统会生成一份可以继续修改的详细配置。"
                    : "详细设置 Agent 的身份、模型、工具权限和系统提示词。"}
              </p>
              {isDetailed ? <EditTabBar activeTab={editTab} onChange={setEditTab} /> : null}
            </>
          )}

        {/* Quick create: conversational draft */}
        {isQuick ? (
          <div className="mt-4">
            <label className="block text-sm font-medium text-slate-700">
              描述你想要的 Agent <span className="text-red-500">*</span>
            </label>
            <textarea
              className="mt-1 h-28 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400 resize-y"
              placeholder="例如：一个前端开发 Agent，擅长 React 和 TypeScript，能读写文件、运行构建命令、部署预览"
              value={quickDesc}
              onChange={(e) => setQuickDesc(e.target.value)}
            />
            <p className="mt-1 text-xs text-slate-400">AI 会根据描述自动推荐名称、工具和系统提示词。</p>
            <button
              onClick={handleGenerateDraft}
              disabled={!quickDesc.trim()}
              className="mt-3 h-9 w-full rounded-lg bg-slate-950 text-sm font-medium text-white disabled:opacity-50 hover:bg-slate-800"
            >
              生成草稿并预览
            </button>
          </div>
        ) : null}

        {isDetailed ? (
        <section className={editTab === "basic" ? "" : "hidden"}>
        {/* Name */}
        <label className="mt-4 block text-sm font-medium text-stone-700">
          名称 <span className="text-red-500">*</span>
        </label>
        <input
          className="mt-1 h-9 w-full rounded-md border border-stone-300 px-3 text-sm outline-none focus:border-stone-500"
          placeholder="例如：代码审查助手"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="mt-4 block text-sm font-medium text-stone-700">
          Agent 描述 <span className="text-red-500">*</span>
        </label>
        <textarea
          className="mt-1 min-h-24 w-full resize-y rounded-md border border-stone-300 px-3 py-2 text-sm leading-6 outline-none focus:border-stone-500"
          placeholder="说明这个 Agent 的职责、适合处理的问题，以及协作时的默认行为。"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
        />
        <div className="mt-1 flex justify-between text-xs text-stone-400">
          <span>会显示在 Agent 信息卡片中。</span>
          <span>{description.length}/500</span>
        </div>

        <label className="mt-4 block text-sm font-medium text-stone-700">能力标签（选填）</label>
        <input
          className="mt-1 h-9 w-full rounded-md border border-stone-300 px-3 text-sm outline-none focus:border-stone-500"
          placeholder="例如：前端, 视觉, 代码审查"
          value={capabilitiesInput}
          onChange={(e) => setCapabilitiesInput(e.target.value)}
        />
        <p className="mt-1 text-xs text-stone-400">用逗号、顿号或换行分隔，最多 10 个，会显示在 Agent 卡片里。</p>
        {capabilities.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {capabilities.map((capability) => (
              <span key={capability} className="rounded-md bg-blue-50 px-2 py-1 text-xs text-blue-700">
                {capability}
              </span>
            ))}
          </div>
        ) : null}

        {isEdit ? (
          <div className="mt-4 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            <div className="flex items-center justify-between gap-3">
              <span>运行方式</span>
              <span className="font-medium text-slate-800">{adapterName === "custom" ? "Custom Agent" : adapterName}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>当前模型</span>
              <span className="font-mono text-slate-800">{modelId || "未指定"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>已授权工具</span>
              <span className="font-medium text-slate-800">{toolNames.length} 个</span>
            </div>
          </div>
        ) : null}

        {!isEdit ? (
          <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
            运行方式：Custom · 默认 Provider：DeepSeek。Claude/Codex SDK 入口已隐藏。
          </div>
        ) : isSdk && isSdkDisabled ? (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            这是历史 SDK Agent。当前项目只维护 Custom/DeepSeek 配置，建议切换或重新创建。
          </div>
        ) : null}

        {draftBasis ? (
          <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800">
            <strong>草稿依据与默认假设：</strong>{draftBasis}
          </div>
        ) : null}
        </section>
        ) : null}

        {isDetailed ? (
        <section className={editTab === "model" ? "" : "hidden"}>
        {/* Provider & Model (Custom only) */}
        {!isSdk ? (
          <>
            <label className="mt-4 block text-sm font-medium text-stone-700">
              Provider
            </label>
            <select
              className="mt-1 h-9 w-full rounded-md border border-stone-300 px-3 text-sm outline-none"
              value={modelProvider ?? "deepseek"}
              onChange={(e) => {
                const provider = e.target.value as ModelProvider;
                setModelProvider(provider);
                setModelId(PROVIDER_DEFAULT_MODELS[provider] ?? "");
                setError(null);
              }}
            >
              <option value="deepseek">DeepSeek</option>
              <option value="openai">OpenAI</option>
              <option value="volcano-ark">火山方舟</option>
              <option value="openai-compatible">OpenAI-Compatible（需 Key + URL）</option>
            </select>

            <label className="mt-3 block text-sm font-medium text-stone-700">
              Model ID <span className="text-red-500">*</span>
            </label>
            <input
              className="mt-1 h-9 w-full rounded-md border border-stone-300 px-3 text-sm outline-none focus:border-stone-500"
              placeholder="deepseek-chat"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
            />
          </>
        ) : null}

        {/* API Key */}
        <label className="mt-3 block text-sm font-medium text-stone-700">API Key（可选，覆盖全局设置）</label>
        <div className="mt-1 flex gap-2">
          <input
            className="h-9 flex-1 rounded-md border border-stone-300 px-3 text-sm font-mono outline-none focus:border-stone-500"
            type={showApiKey ? "text" : "password"}
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button
            type="button"
            onClick={() => setShowApiKey((prev) => !prev)}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-stone-200 text-stone-500 hover:bg-stone-50"
            title={showApiKey ? "隐藏" : "显示"}
          >
            {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>

        {/* Base URL */}
        <label className="mt-3 block text-sm font-medium text-stone-700">API Base URL（可选）</label>
        <input
          className="mt-1 h-9 w-full rounded-md border border-stone-300 px-3 text-sm outline-none"
          placeholder={isSdk ? "SDK 自动管理" : "留空使用默认"}
          value={apiBaseUrl}
          onChange={(e) => setApiBaseUrl(e.target.value)}
          disabled={isSdk}
        />
        </section>
        ) : null}

        {isDetailed ? (
        <section className={editTab === "tools" ? "" : "hidden"}>
        <div className="mt-4 rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-3 py-2">
            <div className="text-sm font-medium text-stone-800">系统提示词</div>
            <p className="mt-0.5 text-xs text-stone-500">定义 Agent 的角色、边界、输出风格和协作规则。</p>
          </div>
          <textarea
            className="min-h-40 w-full resize-y rounded-b-lg border-0 px-3 py-3 font-mono text-xs leading-6 outline-none"
            placeholder="留空使用默认提示词..."
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </div>

        {/* Tools (Custom only) */}
        {!isSdk ? (
          <>
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-stone-800">工具权限</div>
                  <p className="mt-0.5 text-xs text-stone-500">先选择预设，再按需微调高风险工具。</p>
                </div>
                <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                  {toolNames.length} 已选
                </span>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                {(Object.entries(TOOL_PRESETS) as [ToolPresetName, { label: string; tools: string[] }][]).map(
                  ([key, preset]) => (
                    <button
                      key={key}
                      type="button"
                      className="rounded-md border border-stone-200 bg-white px-3 py-2 text-left text-xs text-stone-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                      onClick={() => handlePreset(key)}
                    >
                      <span className="block font-medium">{preset.label}</span>
                      <span className="mt-1 block text-[10px] text-stone-400">{preset.tools.length} 个工具</span>
                    </button>
                  )
                )}
              </div>
            </div>

            <div className="mt-3 space-y-3">
              {TOOL_GROUPS.map((group) => (
                <div key={group.label} className="rounded-lg border border-slate-200 bg-white p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div className={`text-xs font-semibold ${group.tone === "danger" ? "text-red-600" : "text-slate-600"}`}>{group.label}</div>
                    {group.tone === "danger" ? (
                      <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-600">谨慎授权</span>
                    ) : (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">低风险</span>
                    )}
                  </div>
                  <div className="grid gap-2">
                    {group.tools.map((tool) => (
                      <label
                        key={tool}
                        className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs transition ${
                          toolNames.includes(tool)
                            ? "border-[#4264ff] bg-[#eff5ff] text-[#2546d8]"
                            : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[#4264ff]"
                          checked={toolNames.includes(tool)}
                          onChange={() => toggleTool(tool)}
                        />
                        <span className="min-w-0">
                          <span className="block font-medium">{TOOL_META[tool]?.label ?? tool}</span>
                          <span className="mt-0.5 block text-[10px] leading-4 opacity-70">{TOOL_META[tool]?.description}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="mt-4 text-xs text-stone-500">
            SDK 适配器使用内置工具集，无需手动配置。
          </p>
        )}
        </section>
        ) : null}

        </div>

        {/* Actions */}
        <div className="shrink-0 border-t border-stone-200 bg-white px-6 py-4">
        {error ? (
          <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            className="h-9 rounded-md px-4 text-sm text-stone-600 hover:bg-stone-100"
            onClick={handleClose}
            disabled={submitting}
          >
            取消
          </button>
          {isDetailed ? (
            <button
              type="button"
              className="h-9 rounded-md bg-stone-950 px-4 text-sm font-medium text-white disabled:opacity-50"
              onClick={handleSubmit}
              disabled={!name.trim() || !description.trim() || submitting}
            >
              {submitting ? "保存中..." : isEdit ? "保存修改" : "创建 Agent"}
            </button>
          ) : null}
        </div>
        </div>
      </div>
    </div>
  );
}

function EditTabBar({ activeTab, onChange }: { activeTab: AgentEditTab; onChange: (tab: AgentEditTab) => void }) {
  const tabs = [
    { id: "basic" as const, label: "基本信息", icon: <User className="h-4 w-4" /> },
    { id: "model" as const, label: "模型与适配器", icon: <Cpu className="h-4 w-4" /> },
    { id: "tools" as const, label: "工具与提示词", icon: <Wrench className="h-4 w-4" /> }
  ];

  return (
    <div className="mt-4 flex w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 text-sm font-medium transition ${
            activeTab === tab.id
              ? "bg-white text-[#2546d8] shadow-sm ring-1 ring-[#4264ff]"
              : "text-slate-500 hover:bg-white/70 hover:text-slate-800"
          }`}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function parseCapabilities(input: string) {
  return input
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 10);
}
