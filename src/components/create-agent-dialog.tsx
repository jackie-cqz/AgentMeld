"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Cpu,
  FileText,
  SlidersHorizontal,
  Sparkles,
  User,
  Wrench
} from "lucide-react";
import type { AdapterName, ModelProvider } from "@/shared/types";
import { emptyAgentModel, type AgentModelValue } from "@/lib/agent-model-config";
import { harnessDisplayLabel, harnessEditorModel } from "@/lib/harness-selection";
import { isSelectableAdapter, type HarnessAvailability } from "@/shared/harness-catalog";
import { AgentModelConfig } from "@/components/agent-model-config";
import { AgentAvatarPicker } from "@/components/agent-avatar-picker";
import { HarnessPicker } from "@/components/harness-picker";
import { PiRuntimeStatus } from "@/components/pi-runtime-status";
import { AGENT_AVATAR_AUTO } from "@/shared/agent-avatar-presets";
import { Modal, useUnsavedChanges } from "@/components/ui/modal";
import { Feedback, Tabs, SectionHeading } from "@/components/ui/controls";
import { useAppStore } from "@/stores/app-store";
import { requestJson } from "@/lib/request-json";
import { getToolDisplayName } from "@/shared/tool-display";
import { DEFAULT_CUSTOM_PROMPT } from "@/shared/agent-constants";

type AgentEditTab = "basic" | "model" | "tools" | "prompt";
type CreateStage = "choice" | "quick" | "detailed";

interface CreateAgentDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (payload: {
    name: string;
    avatar?: string;
    description: string;
    capabilities?: string[];
    adapterName: AdapterName;
    modelProvider?: ModelProvider | null;
    modelId?: string | null;
    apiKey?: string | null;
    apiBaseUrl?: string | null;
    contextWindow?: number | null;
    reasoningEffort?: "low" | "medium" | "high" | null;
    systemPrompt?: string;
  }) => Promise<void>;
  // Edit mode: pre-fill form with existing agent data
  initial?: {
    name: string;
    avatar?: string;
    isConductor?: boolean;
    description: string;
    capabilities: string[];
    adapterName: AdapterName;
    modelProvider: ModelProvider | null;
    modelId: string | null;
    apiKey: string | null;
    apiBaseUrl: string | null;
    contextWindow: number | null;
    reasoningEffort: "low" | "medium" | "high" | null;
    systemPrompt: string;
  };
}

export function CreateAgentDialog({ open, onClose, onCreate, initial }: CreateAgentDialogProps) {
  const isEdit = !!initial;
  // The real per-run toolset comes from the server (provisionedPlatformToolNames).
  // Issue #79 made capability open, so the editor shows the runtime truth only:
  // there is no per-Agent tool record to edit, grant, or restrict.
  const provisionedToolNames = useAppStore((state) => state.provisionedToolNames);
  const [createStage, setCreateStage] = useState<CreateStage>(isEdit ? "detailed" : "choice");
  const [quickDesc, setQuickDesc] = useState("");
  const [name, setName] = useState(initial?.name ?? "");
  const [avatar, setAvatar] = useState(initial?.avatar ?? AGENT_AVATAR_AUTO);
  const formRef = useRef<HTMLDivElement>(null);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [capabilitiesInput, setCapabilitiesInput] = useState((initial?.capabilities ?? []).join("，"));
  // The engine is a real, editable choice now. A stored retired name is not a
  // choice: the editor opens on the migration target (Pi) and says so, which is
  // also what saving does. A current name (Pi or OpenCode) opens selected.
  const initialAdapter: AdapterName = initial && isSelectableAdapter(initial.adapterName) ? initial.adapterName : "pi";
  const [adapterName, setAdapterName] = useState<AdapterName>(initialAdapter);
  // Runtime truth for the picker, refreshed from /api/harnesses on every open.
  // Until it arrives the catalog's declared states are shown, and nothing is
  // claimed to be runnable.
  const [availability, setAvailability] = useState<HarnessAvailability[] | null>(null);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [availabilityRevision, setAvailabilityRevision] = useState(0);
  const [modelConfig, setModelConfig] = useState<AgentModelValue>(() => ({
    provider: initial?.modelProvider ?? null, modelId: initial?.modelId ?? "",
    apiKey: initial?.apiKey ?? "", apiBaseUrl: initial?.apiBaseUrl ?? "",
    contextWindow: initial?.contextWindow === null || initial?.contextWindow === undefined ? "" : String(initial.contextWindow),
    reasoningEffort: initial?.reasoningEffort ?? ""
  }));
  const { provider: modelProvider, modelId, apiKey, apiBaseUrl, contextWindow, reasoningEffort } = modelConfig;
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? DEFAULT_CUSTOM_PROMPT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftBasis, setDraftBasis] = useState<string | null>(null);
  const [editTab, setEditTab] = useState<AgentEditTab>("basic");

  const isChoice = !isEdit && createStage === "choice";
  const isQuick = !isEdit && createStage === "quick";
  const isDetailed = isEdit || createStage === "detailed";

  useEffect(() => {
    if (open) formRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [open, createStage]);

  useEffect(() => {
    if (open) {
      const scroller = formRef.current?.closest<HTMLElement>("[data-ui-scroll]");
      if (scroller) scroller.scrollTop = 0;
    }
  }, [open, editTab, createStage]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    requestJson<{ harnesses?: HarnessAvailability[] }>("/api/harnesses", { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(payload.harnesses)) throw new Error("执行引擎安装状态读取失败。");
        setAvailability(payload.harnesses);
        setAvailabilityError(null);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setAvailabilityError(failure instanceof Error ? failure.message : "执行引擎安装状态读取失败。");
        }
      });
    return () => controller.abort();
  }, [open, availabilityRevision]);

  const resetCreateForm = () => {
    if (isEdit) return;
    setCreateStage("choice");
    setQuickDesc("");
    setName("");
    setAvatar(AGENT_AVATAR_AUTO);
    setDescription("");
    setCapabilitiesInput("");
    setAdapterName("pi");
    setAvailability(null);
    setModelConfig(emptyAgentModel());
    setSystemPrompt(DEFAULT_CUSTOM_PROMPT);
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
    const draft: { name: string; prompt: string } = {
      name: quickDesc.slice(0, 30).replace(/[，,。.]/g, "").trim() || "新 Agent",
      prompt: `${DEFAULT_CUSTOM_PROMPT}\n\nSpecialized role:\n${quickDesc}`
    };

    if (desc.includes("前端") || desc.includes("代码") || desc.includes("react") || desc.includes("vue")) {
      draft.name = draft.name || "前端开发";
      draft.prompt = `You are a frontend developer. Write clean, working code. Use fs_patch for focused source edits, fs_write for new or complete files, bash for build/test or dependency installation that requires user approval, and write_artifact for deliverable demos. ${quickDesc}`;
    } else if (desc.includes("审查") || desc.includes("review") || desc.includes("代码审查")) {
      draft.name = draft.name || "代码审查";
      draft.prompt = `You are a code reviewer. Read code, check for issues, and provide clear feedback. Use fs_read and read_artifact to access files. ${quickDesc}`;
    } else if (desc.includes("部署") || desc.includes("deploy") || desc.includes("发布")) {
      draft.name = draft.name || "部署助手";
      draft.prompt = `You are a deployment assistant. Build, test, and deploy projects. ${quickDesc}`;
    } else if (desc.includes("文档") || desc.includes("写作") || desc.includes("doc")) {
      draft.name = draft.name || "文档写作";
      draft.prompt = `You are a technical writer. Produce clear, well-structured documents using write_artifact. ${quickDesc}`;
    } else if (desc.includes("研究") || desc.includes("调研") || desc.includes("research")) {
      draft.name = draft.name || "研究分析";
      draft.prompt = `${DEFAULT_CUSTOM_PROMPT}\n\n## Specialized role\nYou are a research analyst. Compare evidence, identify uncertainty, and deliver a structured report artifact.\n\nUser role description:\n${quickDesc}`;
    }

    setName(draft.name);
    setDescription(quickDesc.trim());
    setSystemPrompt(draft.prompt);
    setDraftBasis(`根据“${quickDesc.trim().slice(0, 80)}”生成普通协作 Agent，请确认模型后保存。`);
    setEditTab("basic");
    setCreateStage("detailed");
  };

  const capabilities = parseCapabilities(capabilitiesInput);
  // One derivation for the picker, the basic-tab summary and the save button, so
  // they cannot disagree about whether the selection can actually run.
  const harness = harnessEditorModel({ availability, selected: adapterName, stored: initial?.adapterName ?? null });

  const handleSubmit = async () => {
    if (submitting) return;
    if (!name.trim()) return;
    setError(null);
    if (!description.trim()) {
      setError("Agent 描述为必填项，会显示在 Agent 卡片中。");
      setEditTab("basic");
      return;
    }
    if (!harness.canSave) {
      setError("请选择一个可保存的执行引擎。");
      setEditTab("model");
      return;
    }
    // Config validation
    if (!modelId?.trim()) {
      setError("请选择供应商和模型。");
      setEditTab("model");
      return;
    }
    if (!modelProvider) {
      setError("请选择模型供应商。");
      setEditTab("model");
      return;
    }
    if (contextWindow.trim() && (!/^\d+$/.test(contextWindow.trim()) || Number(contextWindow) < 1000 || Number(contextWindow) > 10_000_000)) {
      setError("模型窗口必须是 1,000 到 10,000,000 之间的整数，或留空使用供应商默认值。");
      setEditTab("model");
      return;
    }
    if (modelProvider === "openai-compatible") {
      if (!apiKey.trim()) {
        setError("OpenAI-Compatible 必须提供 API Key。");
        setEditTab("model");
        return;
      }
      if (!apiBaseUrl.trim()) {
        setError("OpenAI-Compatible 必须提供 API Base URL。");
        setEditTab("model");
        return;
      }
    }
    setSubmitting(true);
    try {
      await onCreate({
        name: name.trim(),
        avatar,
        description: description.trim(),
        capabilities,
        adapterName,
        modelProvider,
        modelId: modelId.trim() || null,
        apiKey: apiKey.trim() || null,
        apiBaseUrl: apiBaseUrl.trim() || null,
        contextWindow: contextWindow.trim() ? Number(contextWindow.trim()) : null,
        reasoningEffort: reasoningEffort || null,
        systemPrompt: systemPrompt.trim() || undefined
      });
      resetCreateForm();
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "保存 Agent 失败。");
    } finally {
      setSubmitting(false);
    }
  };

  const original = JSON.stringify([initial?.name ?? "", initial?.description ?? "", (initial?.capabilities ?? []).join("，"), initialAdapter, initial?.modelProvider ?? null, initial?.modelId ?? "", initial?.apiKey ?? "", initial?.apiBaseUrl ?? "", initial?.contextWindow ?? "", initial?.reasoningEffort ?? "", initial?.systemPrompt ?? DEFAULT_CUSTOM_PROMPT]);
  const dirty = avatar !== (initial?.avatar ?? AGENT_AVATAR_AUTO) || Boolean(quickDesc.trim()) || JSON.stringify([name, description, capabilitiesInput, adapterName, modelProvider, modelId, apiKey, apiBaseUrl, contextWindow, reasoningEffort, systemPrompt]) !== original;
  const discard = useUnsavedChanges(dirty, handleClose, submitting);
  return (
    <><Modal open={open} onClose={discard.requestClose} title={isEdit ? "编辑 Agent" : isChoice ? "新建 Agent" : isQuick ? "快速创建" : "详细配置"}
      description={isEdit ? initial?.name : undefined} className={isDetailed ? "agent-editor-dialog" : "agent-create-dialog"} size={isDetailed ? "wide" : "medium"} busy={submitting}
      navigation={isDetailed ? <EditTabBar activeTab={editTab} onChange={setEditTab} /> : undefined}
      footer={<>{error ? <Feedback>{error}</Feedback> : null}
        {!isEdit && !isChoice ? <button disabled={submitting} className="ui-button ui-button--quiet mr-auto" onClick={() => { setError(null); setCreateStage("choice"); }}><ArrowLeft size={15} />返回</button> : null}
        <button className="ui-button ui-button--quiet" onClick={discard.requestClose} disabled={submitting}>取消</button>
        {isQuick ? <button className="ui-button ui-button--primary" disabled={!quickDesc.trim()} onClick={handleGenerateDraft}><Sparkles size={14} />生成草稿并预览</button> : null}
        {isDetailed ? <button className="ui-button ui-button--primary" onClick={() => void handleSubmit()} disabled={!name.trim() || !description.trim() || submitting}>{submitting ? "保存中..." : isEdit ? "保存修改" : "创建 Agent"}{harness.saveSuffix}</button> : null}</>}>
        <div ref={formRef} className={`ui-form ${isDetailed ? "ui-agent-form" : "agent-entry-form"}`}>
          {isChoice ? <div className="agent-create-methods">
            <button type="button" data-autofocus onClick={() => setCreateStage("quick")}>
              <Sparkles size={23} strokeWidth={1.6} /><strong>快速创建</strong><span>从职责描述开始</span><ArrowRight size={16} />
            </button>
            <button type="button" onClick={() => { setEditTab("basic"); setCreateStage("detailed"); }}>
              <SlidersHorizontal size={23} strokeWidth={1.6} /><strong>详细配置</strong><span>从空白配置开始</span><ArrowRight size={16} />
            </button>
          </div> : null}

        {/* Quick create: conversational draft */}
        {isQuick ? (
          <div className="agent-quick-form">
            <label className="block text-sm font-medium text-slate-700">
              描述你想要的 Agent <span className="text-red-500">*</span>
            </label>
            <textarea
              className="mt-1 h-28 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400 resize-y"
              placeholder="例如：一个前端开发 Agent，擅长 React 和 TypeScript，能读写文件、运行构建命令、部署预览"
              data-autofocus
              aria-label="Agent 职责描述"
              maxLength={500}
              value={quickDesc}
              onChange={(e) => setQuickDesc(e.target.value)}
            />
            <span className="agent-quick-count">{quickDesc.length}/500</span>
          </div>
        ) : null}

        {isDetailed ? (
        <section role="tabpanel" aria-label="基本信息" className={editTab === "basic" ? "" : "hidden"}>
        <AgentAvatarPicker agent={{ id: "draft", name, capabilities, isConductor: initial?.isConductor ?? false, avatar }} value={avatar} onChange={setAvatar} />
        {/* Name */}
        <label className="mt-4 block text-sm font-medium text-stone-700">
          名称 <span className="text-red-500">*</span>
        </label>
        <input
          className="mt-1 h-9 w-full rounded-md border border-stone-300 px-3 text-sm outline-none focus:border-stone-500"
          placeholder="例如：代码审查助手"
          aria-label="名称"
          maxLength={80}
          data-autofocus
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="mt-4 block text-sm font-medium text-stone-700">
          Agent 描述 <span className="text-red-500">*</span>
        </label>
        <textarea
          className="mt-1 min-h-24 w-full resize-y rounded-md border border-stone-300 px-3 py-2 text-sm leading-6 outline-none focus:border-stone-500"
          placeholder="说明这个 Agent 的职责、适合处理的问题，以及协作时的默认行为。"
          aria-label="Agent 描述"
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
          aria-label="能力标签"
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
              <span className="font-medium text-slate-800">{harnessDisplayLabel(adapterName)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>当前模型</span>
              <span className="font-mono text-slate-800">{modelId || "未指定"}</span>
            </div>
          </div>
        ) : null}

        {!isEdit ? (
          <div className={`mt-4 rounded-md border px-3 py-2 text-xs leading-5 ${harness.selected?.state === "available"
            ? "border-blue-200 bg-blue-50 text-blue-800"
            : "border-amber-200 bg-amber-50 text-amber-800"}`}>
            执行引擎：{harnessDisplayLabel(adapterName)}。{harness.selected?.checked
              ? harness.statusText
              : "可在「模型与执行引擎」中切换；只有标为「可用」的引擎，运行才会真正执行。"}
          </div>
        ) : harness.migrationNotice ? (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
            {harness.migrationNotice}
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
        <section role="tabpanel" aria-label="模型与执行引擎" className={editTab === "model" ? "" : "hidden"}>
        <HarnessPicker
          model={harness}
          loading={availability === null && availabilityError === null}
          error={availabilityError}
          onSelect={(value) => { setAdapterName(value); setError(null); }}
          onRefresh={() => { setAvailability(null); setAvailabilityError(null); setAvailabilityRevision(current => current + 1); }}
        />
        {adapterName === "pi" ? <PiRuntimeStatus open={open} /> : null}
        <AgentModelConfig open={open} value={modelConfig} onChange={value => { setModelConfig(value); setError(null); }} />
        </section>
        ) : null}

        {isDetailed ? (
        <section role="tabpanel" aria-label="运行时工具" className={editTab === "tools" ? "agent-tools-panel" : "hidden"}>
          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
            Pi 运行时为每个 Agent 提供完整工具集，<strong>所有 Agent 相同</strong>，不按 Agent 配置授权或限制任何能力。下面是运行时下发的真实工具集，仅供参考。
          </div>

          <div className="mt-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-stone-800">运行时可用的工具</div>
              <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                {provisionedToolNames.length} 个 · 所有 Agent 相同
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {provisionedToolNames.map((tool) => (
                <span key={tool} title={getToolDisplayName(tool)} className="rounded-md bg-[var(--ui-subtle)] px-2 py-1 font-mono text-[11px] text-[var(--ui-muted)]">{tool}</span>
              ))}
              {provisionedToolNames.length === 0 ? <span className="ui-muted text-xs">运行时工具集暂不可用（未能从服务端读取）。</span> : null}
            </div>
            <p className="mt-1 text-xs text-slate-400">由 Pi 运行时实际注入，无法在此编辑；Conductor 的规划阶段另有自己的阶段性工具集（见 docs/pi-runtime.md）。</p>
          </div>
        </section>
        ) : null}

        {isDetailed ? (
        <section role="tabpanel" aria-label="系统提示词" className={editTab === "prompt" ? "ui-prompt-panel" : "hidden"}>
          <SectionHeading title="系统提示词" detail="角色、边界与协作规则" />
          <textarea
            placeholder="留空使用默认提示词..."
            aria-label="系统提示词"
            spellCheck={false}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </section>
        ) : null}

        </div>

    </Modal>{discard.confirmation}</>
  );
}

function EditTabBar({ activeTab, onChange }: { activeTab: AgentEditTab; onChange: (tab: AgentEditTab) => void }) {
  const tabs = [
    { id: "basic" as const, label: "基本信息", icon: <User className="h-4 w-4" /> },
    { id: "model" as const, label: "模型与执行引擎", icon: <Cpu className="h-4 w-4" /> },
    { id: "tools" as const, label: "运行时工具", icon: <Wrench className="h-4 w-4" /> },
    { id: "prompt" as const, label: "系统提示词", icon: <FileText className="h-4 w-4" /> }
  ];

  return <Tabs value={activeTab} onChange={onChange} label="Agent 配置" items={tabs.map(tab => ({ value: tab.id, label: tab.label, icon: tab.icon }))} />;
}

function parseCapabilities(input: string) {
  return input
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 10);
}
