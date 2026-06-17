"use client";

import { useState } from "react";
import type { AdapterName, ModelProvider } from "@/shared/types";
import { ALL_TOOL_NAMES, TOOL_PRESETS, type ToolPresetName } from "@/shared/agent-constants";

const TOOL_GROUPS = [
  { label: "文件操作", tools: ["fs_read", "fs_write", "fs_list"] as const },
  { label: "Shell", tools: ["bash"] as const },
  { label: "产物", tools: ["write_artifact", "read_artifact", "deploy_artifact", "deploy_workspace"] as const },
  { label: "交互", tools: ["ask_user"] as const },
];

interface CreateAgentDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (payload: {
    name: string;
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
  const [wizardMode, setWizardMode] = useState<"quick" | "detailed">(isEdit ? "detailed" : "quick");
  const [quickDesc, setQuickDesc] = useState("");
  const [name, setName] = useState(initial?.name ?? "");
  const [adapterName, setAdapterName] = useState<AdapterName>(initial?.adapterName ?? "custom");
  const [modelProvider, setModelProvider] = useState<ModelProvider | null>(initial?.modelProvider ?? "openai");
  const [modelId, setModelId] = useState(initial?.modelId ?? "gpt-4.1-mini");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [apiBaseUrl, setApiBaseUrl] = useState(initial?.apiBaseUrl ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [toolNames, setToolNames] = useState<string[]>(initial?.toolNames ?? ["write_artifact"]);
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const isSdk = adapterName === "claude-code" || adapterName === "codex";
  const isSdkDisabled = true;
  const anthropicDisabled = true;

  const handleGenerateDraft = () => {
    if (!quickDesc.trim()) return;
    // Simple heuristic: extract intent from description
    const desc = quickDesc.toLowerCase();
    const draft: { name: string; tools: string[]; prompt: string } = {
      name: quickDesc.slice(0, 30).replace(/[，,。.]/g, "").trim() || "新 Agent",
      tools: ["write_artifact"],
      prompt: `You are a helpful assistant. ${quickDesc}`
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
    }

    setName(draft.name);
    setToolNames(draft.tools);
    setSystemPrompt(draft.prompt);
    setWizardMode("detailed");
  };

  const handlePreset = (presetName: ToolPresetName) => {
    setToolNames([...TOOL_PRESETS[presetName].tools]);
  };

  const toggleTool = (tool: string) => {
    setToolNames((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]
    );
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    // Config validation
    if (!isSdk && !modelId?.trim()) {
      alert("Custom 适配器必须指定 Model ID。");
      return;
    }
    if (!isSdk && modelProvider === "openai-compatible") {
      if (!apiKey.trim()) {
        alert("OpenAI-Compatible 必须提供 API Key。");
        return;
      }
      if (!apiBaseUrl.trim()) {
        alert("OpenAI-Compatible 必须提供 API Base URL。");
        return;
      }
    }
    setSubmitting(true);
    try {
      await onCreate({
        name: name.trim(),
        adapterName,
        modelProvider: isSdk ? undefined : modelProvider,
        modelId: isSdk ? null : (modelId.trim() || null),
        apiKey: apiKey.trim() || null,
        apiBaseUrl: apiBaseUrl.trim() || null,
        systemPrompt: systemPrompt.trim() || undefined,
        toolNames: isSdk ? [] : toolNames
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/30 px-4">
      <div className="w-full max-w-md rounded-lg border border-stone-200 bg-white p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-stone-950">{isEdit ? "编辑 Agent" : "新建 Agent"}</h2>

        {/* Wizard mode toggle */}
        {!isEdit ? (
          <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
            <button
              className={`h-8 rounded-md text-xs font-medium transition ${wizardMode === "quick" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}
              onClick={() => setWizardMode("quick")}
            >快速创建</button>
            <button
              className={`h-8 rounded-md text-xs font-medium transition ${wizardMode === "detailed" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}
              onClick={() => setWizardMode("detailed")}
            >详细配置</button>
          </div>
        ) : null}

        {/* Quick create: conversational draft */}
        {wizardMode === "quick" && !isEdit ? (
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

        {/* Adapter */}
        {!isEdit ? (
          <>
            <label className="mt-4 block text-sm font-medium text-stone-700">适配器</label>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {(["custom", "claude-code", "codex"] as AdapterName[]).map((a) => {
                const disabled = a !== "custom" && isSdkDisabled;
                return (
                  <button
                    key={a}
                    type="button"
                    disabled={disabled}
                    className={`rounded-md border px-3 py-2 text-xs font-medium transition ${
                      adapterName === a
                        ? "border-stone-950 bg-stone-950 text-white"
                        : disabled
                          ? "border-stone-100 bg-stone-50 text-stone-300 cursor-not-allowed"
                          : "border-stone-200 text-stone-600 hover:bg-stone-50"
                    }`}
                    onClick={() => setAdapterName(a)}
                    title={disabled ? "SDK adapter 尚未接入" : undefined}
                  >
                    {a === "custom" ? "Custom" : a === "claude-code" ? "Claude Code" : "Codex"}
                    {disabled ? <span className="block text-[10px]">规划中</span> : null}
                  </button>
                );
              })}
            </div>
          </>
        ) : null}

        {/* Provider & Model (Custom only) */}
        {!isSdk ? (
          <>
            <label className="mt-4 block text-sm font-medium text-stone-700">
              Provider
            </label>
            <select
              className="mt-1 h-9 w-full rounded-md border border-stone-300 px-3 text-sm outline-none"
              value={modelProvider ?? "openai"}
              onChange={(e) => setModelProvider(e.target.value as ModelProvider)}
            >
              <option value="openai">OpenAI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="volcano-ark">火山方舟</option>
              <option value="openai-compatible">OpenAI-Compatible（需 Key + URL）</option>
            </select>

            <label className="mt-3 block text-sm font-medium text-stone-700">
              Model ID <span className="text-red-500">*</span>
            </label>
            <input
              className="mt-1 h-9 w-full rounded-md border border-stone-300 px-3 text-sm outline-none focus:border-stone-500"
              placeholder="gpt-4.1-mini"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
            />
          </>
        ) : null}

        {/* API Key */}
        <label className="mt-3 block text-sm font-medium text-stone-700">API Key（可选，覆盖全局设置）</label>
        <input
          className="mt-1 h-9 w-full rounded-md border border-stone-300 px-3 text-sm outline-none"
          type="password"
          placeholder="sk-..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />

        {/* Base URL */}
        <label className="mt-3 block text-sm font-medium text-stone-700">API Base URL（可选）</label>
        <input
          className="mt-1 h-9 w-full rounded-md border border-stone-300 px-3 text-sm outline-none"
          placeholder={isSdk ? "SDK 自动管理" : "留空使用默认"}
          value={apiBaseUrl}
          onChange={(e) => setApiBaseUrl(e.target.value)}
          disabled={isSdk}
        />

        {/* System Prompt */}
        <label className="mt-3 block text-sm font-medium text-stone-700">System Prompt</label>
        <textarea
          className="mt-1 h-24 w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none resize-y"
          placeholder="留空使用默认提示词..."
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
        />

        {/* Tools (Custom only) */}
        {!isSdk ? (
          <>
            <label className="mt-4 block text-sm font-medium text-stone-700">工具</label>
            {/* Presets */}
            <div className="mt-1 flex flex-wrap gap-1">
              {(Object.entries(TOOL_PRESETS) as [ToolPresetName, { label: string; tools: string[] }][]).map(
                ([key, preset]) => (
                  <button
                    key={key}
                    type="button"
                    className="rounded-md border border-stone-200 px-2 py-1 text-xs text-stone-600 hover:bg-stone-100"
                    onClick={() => handlePreset(key)}
                  >
                    {preset.label}
                  </button>
                )
              )}
            </div>
            {/* Tools grouped by purpose */}
            <div className="mt-2 space-y-2 max-h-48 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50 p-2">
              {TOOL_GROUPS.map((group) => (
                <div key={group.label}>
                  <div className="text-[10px] font-medium uppercase text-slate-400 mb-1">{group.label}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {group.tools.map((tool) => (
                      <label
                        key={tool}
                        className={`flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs transition ${
                          toolNames.includes(tool)
                            ? "border-[#4264ff] bg-[#eff5ff] text-[#2546d8]"
                            : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                        }`}
                      >
                        <input
                          type="checkbox" className="sr-only"
                          checked={toolNames.includes(tool)}
                          onChange={() => toggleTool(tool)}
                        />
                        {tool}
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

        {/* Actions */}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            className="h-9 rounded-md px-4 text-sm text-stone-600 hover:bg-stone-100"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            type="button"
            className="h-9 rounded-md bg-stone-950 px-4 text-sm font-medium text-white disabled:opacity-50"
            onClick={handleSubmit}
            disabled={!name.trim() || submitting}
          >
            {submitting ? "保存中..." : isEdit ? "保存修改" : "创建 Agent"}
          </button>
        </div>
      </div>
    </div>
  );
}
