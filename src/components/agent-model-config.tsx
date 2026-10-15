"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Cpu, Eye, EyeOff, KeyRound, Plus, RefreshCw, Search, Settings2, SlidersHorizontal } from "lucide-react";
import type { ModelProviderProfile } from "@/shared/types";
import { useAppStore } from "@/stores/app-store";
import { requestJson } from "@/lib/request-json";
import { agentProviderChoices, selectAgentProvider, type AgentModelValue, type AgentProviderChoice } from "@/lib/agent-model-config";
import type { ProviderSnapshot } from "@/lib/model-provider-settings";
import { Modal } from "@/components/ui/modal";
import { Feedback } from "@/components/ui/controls";
import { SettingsDialog } from "@/components/settings-dialog";

export function AgentModelConfig({ open, value, onChange, sdk = false }: {
  open: boolean; value: AgentModelValue; onChange: (value: AgentModelValue) => void; sdk?: boolean;
}) {
  const agents = useAppStore(state => state.agents);
  const [catalog, setCatalog] = useState<{ profiles: ModelProviderProfile[]; snapshot: ProviderSnapshot } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [picker, setPicker] = useState<"provider" | "model" | null>(null);
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState(false);
  const [modelDraft, setModelDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [manager, setManager] = useState(false);
  const [pendingProvider, setPendingProvider] = useState<AgentProviderChoice | null>(null);

  useEffect(() => {
    if (!open || sdk) return;
    const controller = new AbortController();
    Promise.all([
      requestJson<{ providers: ModelProviderProfile[] }>("/api/model-providers", { signal: controller.signal }),
      requestJson<ProviderSnapshot>("/api/settings", { signal: controller.signal })
    ]).then(([data, snapshot]) => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(data.providers) || !snapshot.settings) throw new Error("供应商配置读取失败。");
      setCatalog({ profiles: data.providers, snapshot }); setError(null);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "供应商配置读取失败。");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, sdk, version]);

  const reload = () => { setLoading(true); setVersion(current => current + 1); };
  const choices = catalog ? agentProviderChoices(catalog.profiles, catalog.snapshot, Object.values(agents), value) : [];
  const selected = choices.find(choice => choice.id === value.provider);
  const models = [...new Set([...(selected?.models ?? []), value.modelId].filter(Boolean))];
  const query = search.trim().toLowerCase();
  const source = value.apiKey ? "Agent 独立密钥" : selected?.source === "environment" ? "环境变量" : selected?.source === "app_settings" ? "供应商密钥" : "未配置密钥";
  const chooseProvider = (choice: AgentProviderChoice) => {
    if (choice.id !== value.provider && (value.apiKey || value.apiBaseUrl)) { setPendingProvider(choice); return; }
    onChange(selectAgentProvider(value, choice)); setPicker(null); setShowKey(false);
  };
  const openPicker = (next: "provider" | "model") => { setSearch(""); setManual(false); setModelDraft(value.modelId); setPicker(next); };
  const manage = () => { setPicker(null); setManager(true); };

  return <>
    <div className="agent-model-config">
      {!sdk ? <>
        <div className="agent-model-heading"><Cpu size={19} /><h3>模型配置</h3><button className="ui-button ui-button--quiet" onClick={manage}><Settings2 size={14} />管理供应商</button></div>
        {error ? <div className="agent-model-notice"><Feedback>{error}</Feedback><button className="ui-button" disabled={loading} onClick={reload}><RefreshCw size={14} />重新加载</button></div> : null}
        <div className="agent-model-field"><label id="agent-provider-label">供应商 <span>*</span></label>
          <button className="agent-model-select" aria-labelledby="agent-provider-label" aria-haspopup="dialog" onClick={() => openPicker("provider")}>
            <span className="provider-mark">{selected?.name.slice(0, 1) ?? <Plus size={16} />}</span>
            <span><strong>{selected?.name ?? (value.provider ? "原供应商配置" : "选择供应商")}</strong><small>{loading ? "正在读取配置…" : selected?.baseUrl || value.provider || "未选择"}</small></span><ChevronDown size={16} />
          </button>
        </div>
        <div className="agent-model-field"><label id="agent-model-label">模型 <span>*</span></label>
          <button className="agent-model-select" aria-labelledby="agent-model-label" aria-haspopup="dialog" disabled={!value.provider} onClick={() => openPicker("model")}>
            <Cpu size={18} /><span><strong>{value.modelId || "选择模型"}</strong><small>{value.modelId && value.modelId === selected?.defaultModel ? "供应商默认模型" : value.modelId ? "Agent 当前模型" : "未选择"}</small></span><ChevronDown size={16} />
          </button>
        </div>
        {value.provider ? <div className="agent-model-meta"><span>Chat Completions</span><span><KeyRound size={12} />{source}</span>{value.apiBaseUrl ? <span>独立 API 地址</span> : null}</div> : null}
        {selected?.source === "missing" && !value.apiKey ? <Feedback tone="info">{selected.unavailable ? "原配置未出现在已配置供应商中。" : "供应商密钥不可用。"}现有选择已保留，请检查供应商或独立配置。</Feedback> : null}
      </> : <div className="agent-model-heading"><Cpu size={19} /><h3>SDK 模型配置</h3></div>}
      <details className="agent-model-advanced" open={sdk || undefined}>
        <summary><SlidersHorizontal size={15} />Agent 独立配置{value.apiKey || value.apiBaseUrl ? <span>已覆盖</span> : null}<ChevronRight size={14} /></summary>
        <label className="ui-field">API Key<div className="provider-key-input"><input aria-label="Agent API Key" autoComplete="off" type={showKey ? "text" : "password"} value={value.apiKey} placeholder="继承供应商密钥" onChange={event => onChange({ ...value, apiKey: event.target.value })} /><button type="button" className="ui-icon-button" title={showKey ? "隐藏密钥" : "显示密钥"} aria-label={showKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
        <label className="ui-field">API 地址<input aria-label="Agent API 地址" type="url" disabled={sdk} value={value.apiBaseUrl} placeholder={sdk ? "SDK 自动管理" : selected?.baseUrl || "继承供应商地址"} onChange={event => onChange({ ...value, apiBaseUrl: event.target.value })} /></label>
      </details>
    </div>
    <Modal open={picker !== null} onClose={() => setPicker(null)} title={picker === "provider" ? "选择供应商" : "选择模型"} description={picker === "model" ? selected?.name : undefined} className="agent-model-picker"
      navigation={<div className="agent-model-search"><Search size={16} /><input data-autofocus aria-label={picker === "provider" ? "搜索已配置供应商" : "搜索模型"} placeholder="搜索" value={search} onChange={event => setSearch(event.target.value)} /></div>}
      footer={picker === "provider" ? <button className="ui-button" onClick={manage}><Plus size={14} />添加或管理供应商</button> : <><button className="ui-button ui-button--quiet mr-auto" onClick={() => { setManual(!manual); setModelDraft(value.modelId); }}>{manual ? "返回模型列表" : "手动填写模型 ID"}</button>{manual ? <button className="ui-button ui-button--primary" disabled={!modelDraft.trim() || modelDraft.trim().length > 100} onClick={() => { onChange({ ...value, modelId: modelDraft.trim() }); setPicker(null); }}>使用此模型</button> : null}</>}>
      {picker === "provider" ? <>
        {loading ? <p className="ui-muted">正在加载供应商…</p> : error ? <><Feedback>{error}</Feedback><button className="ui-button" onClick={reload}><RefreshCw size={14} />重试</button></> : <div className="agent-model-options">
          {choices.filter(choice => `${choice.name} ${choice.baseUrl}`.toLowerCase().includes(query)).map(choice => <button key={choice.id} aria-label={`选择供应商 ${choice.name}`} aria-pressed={choice.id === value.provider} disabled={choice.source === "missing" && choice.id !== value.provider} onClick={() => chooseProvider(choice)}>
            <span className="provider-mark">{choice.name.slice(0, 1)}</span><span><strong>{choice.name}</strong><small>{choice.unavailable ? "原有独立配置" : `${choice.legacy ? "全局配置" : `${choice.models.length} 个模型`} · ${choice.baseUrl}`}</small></span>{choice.id === value.provider ? <Check size={16} /> : <ChevronRight size={15} />}
          </button>)}
          {!choices.some(choice => `${choice.name} ${choice.baseUrl}`.toLowerCase().includes(query)) ? <p className="agent-model-empty">{query ? "未找到匹配的供应商" : "暂无已配置供应商"}</p> : null}
        </div>}
      </> : manual ? <label className="ui-field">模型 ID<input aria-label="手动模型 ID" maxLength={100} value={modelDraft} placeholder="模型 ID" onChange={event => setModelDraft(event.target.value)} /></label> : <div className="agent-model-options">
        {models.filter(model => model.toLowerCase().includes(query)).map(model => <button key={model} aria-label={`选择模型 ${model}`} aria-pressed={model === value.modelId} onClick={() => { onChange({ ...value, modelId: model }); setPicker(null); }}><Cpu size={17} /><span><strong>{model}</strong><small>{model === selected?.defaultModel ? selected?.legacy ? "全局配置参考模型" : "供应商默认" : selected?.models.includes(model) ? selected.legacy ? "现有 Agent 使用" : "供应商模型列表" : "当前自定义模型"}</small></span>{model === value.modelId ? <Check size={16} /> : null}</button>)}
        {!models.some(model => model.toLowerCase().includes(query)) ? <p className="agent-model-empty">未找到模型</p> : null}
      </div>}
    </Modal>
    <Modal open={pendingProvider !== null} onClose={() => setPendingProvider(null)} title="切换供应商？" size="small" footer={<><button className="ui-button" onClick={() => setPendingProvider(null)}>保留当前配置</button><button className="ui-button ui-button--primary" onClick={() => { if (pendingProvider) onChange(selectAgentProvider(value, pendingProvider)); setPendingProvider(null); setPicker(null); setShowKey(false); }}>切换并清除覆盖</button></>}><p className="ui-muted">切换到 {pendingProvider?.name} 会清除这个 Agent 独立设置的 API Key 和地址，并使用新供应商的默认模型。</p></Modal>
    {manager ? <SettingsDialog open onClose={() => { setManager(false); reload(); }} /> : null}
  </>;
}
