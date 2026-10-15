"use client";

import { ArrowLeft, Check, ChevronRight, Cpu, Eye, EyeOff, Globe, KeyRound, Loader2, Pencil, Plus, Search, TestTube2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Modal, useUnsavedChanges } from "@/components/ui/modal";
import { Feedback } from "@/components/ui/controls";
import { requestJson } from "@/lib/request-json";
import { MODEL_PROVIDERS, providerIsListed, providerPatch, providerSource, type ProviderDefinition, type ProviderSnapshot, type ProviderSources, type ProviderValues } from "@/lib/model-provider-settings";
import { useAppStore } from "@/stores/app-store";
import { selectAgentList } from "@/stores/selectors";
import { ProviderProfileEditor } from "@/components/provider-profile-editor";
import { PROVIDER_PRESETS, findProviderPreset, type ProviderPreset } from "@/shared/provider-presets";
import type { ModelProviderProfile } from "@/shared/types";

export function ModelProviderSettings({ settings, sources, onSaved }: { settings: ProviderValues; sources: ProviderSources; onSaved: (snapshot: ProviderSnapshot) => void }) {
  const agents = useAppStore(useShallow(selectAgentList));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProviderDefinition | null>(null);
  const [removing, setRemoving] = useState<ProviderDefinition | null>(null);
  const [removalBusy, setRemovalBusy] = useState(false);
  const [removalError, setRemovalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ModelProviderProfile[]>([]);
  const [environmentPresets, setEnvironmentPresets] = useState<string[]>([]);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [editingProfile, setEditingProfile] = useState<ModelProviderProfile | null>(null);
  const [removingProfile, setRemovingProfile] = useState<ModelProviderProfile | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    requestJson<{ providers: ModelProviderProfile[]; environmentPresets?: string[] }>("/api/model-providers", { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) { if (!Array.isArray(data.providers)) throw new Error("加载供应商配置失败。"); setProfiles(data.providers); setEnvironmentPresets(data.environmentPresets ?? []); setProfileError(null); } })
      .catch(failure => { if (!controller.signal.aborted) setProfileError(failure instanceof Error ? failure.message : "加载供应商配置失败。"); });
    return () => controller.abort();
  }, [loadVersion]);
  const profileSaved = (profile: ModelProviderProfile) => {
    setProfiles(current => [...current.filter(item => item.id !== profile.id), profile]);
    setEditingProfile(null); setAdding(false); setNotice(`${profile.name} 配置已保存。`);
  };
  const listed = MODEL_PROVIDERS.filter(provider => providerIsListed(provider, settings, sources));
  const addable = MODEL_PROVIDERS.filter(provider => !providerIsListed(provider, settings, sources));

  const remove = async () => {
    if (!removing || removalBusy) return;
    setRemovalBusy(true);
    setRemovalError(null);
    try {
      const snapshot = await requestJson<ProviderSnapshot>("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [removing.key]: null, ...(removing.id === "anthropic" ? { anthropicBaseUrl: null } : {}) }) });
      if (!snapshot.settings || !snapshot.keySources) throw new Error("配置已提交，但供应商状态读取失败，请重新打开设置确认。");
      onSaved(snapshot);
      setNotice(providerSource(removing, snapshot.settings, snapshot.keySources) === "environment"
        ? `${removing.name} 的本地配置已移除，当前使用环境变量。` : `${removing.name} 的本地配置已移除。`);
      setRemoving(null);
    } catch (failure) { setRemovalError(failure instanceof Error ? failure.message : "移除配置失败。"); }
    finally { setRemovalBusy(false); }
  };

  return <section className="provider-settings" aria-label="模型供应商">
    <header className="provider-section-heading"><div><h3>模型供应商 <span className="provider-count" aria-hidden="true">{listed.length + profiles.length}</span></h3></div>
      <button className="ui-button" onClick={() => { setNotice(null); setAdding(true); }}><Plus size={15} />添加供应商</button>
    </header>
    {notice ? <div className="provider-notice"><Feedback tone="success">{notice}</Feedback></div> : null}
    {profileError ? <div className="provider-notice"><Feedback>{profileError}</Feedback><button className="ui-button" onClick={() => setLoadVersion(value => value + 1)}>重新加载供应商</button></div> : null}
    {listed.length || profiles.length ? <div className="provider-list">{listed.map(provider => {
      const source = providerSource(provider, settings, sources);
      const associated = agents.filter(agent => agent.adapterName === "claude-code" ? provider.id === "anthropic" : agent.adapterName === "codex" ? provider.id === "openai" : agent.modelProvider === provider.id).length;
      const canRemove = Boolean(settings[provider.key] || (provider.id === "anthropic" && settings.anthropicBaseUrl));
      const models = [...new Set(agents.filter(agent => agent.modelProvider === provider.id).map(agent => agent.modelId).filter((model): model is string => Boolean(model)))];
      return <article className="provider-row" key={provider.id}>
        <button type="button" className="provider-row-main" aria-label={`配置 ${provider.name}`} onClick={() => { setNotice(null); setEditing(provider); }}>
          <ProviderMark provider={provider} />
          <span className="provider-row-title"><strong>{provider.name}</strong><small>{associated ? `${associated} 位 Agent` : "内置供应商"}</small></span>
          <span className={`provider-source ${source === "missing" ? "is-missing" : ""}`}><span />{source === "app_settings" ? "本地凭据" : source === "environment" ? "环境变量" : "未配置凭据"}</span>
          <Pencil size={14} className="provider-edit-icon" />
        </button>
        <button type="button" className="ui-icon-button" aria-label={`移除 ${provider.name} 本地配置`} title={canRemove ? "移除本地配置" : "环境变量由运行环境管理"} disabled={!canRemove}
          onClick={() => { setRemovalError(null); setRemoving(provider); }}><Trash2 size={14} /></button>
        <ProviderSummary protocol={provider.protocol} endpoint={provider.id === "anthropic" && settings.anthropicBaseUrl ? settings.anthropicBaseUrl : provider.endpoint} models={models} />
      </article>;
    })}{profiles.map(profile => <article className="provider-row" key={profile.id}>
      <button className="provider-row-main" aria-label={`配置 ${profile.name}`} onClick={() => setEditingProfile(profile)}>
        <PresetMark id={profile.presetId ?? "custom"} />
        <span className="provider-row-title"><strong>{profile.name}</strong><small>{profile.agentCount ? `${profile.agentCount} 位 Agent` : findProviderPreset(profile.presetId)?.group ?? "自定义供应商"}</small></span>
        <span className={`provider-source ${profile.credentialSource === "missing" ? "is-missing" : ""}`}><span />{profile.credentialSource === "app_settings" ? "本地凭据" : profile.credentialSource === "environment" ? "环境变量" : "未配置凭据"}</span><Pencil size={14} className="provider-edit-icon" />
      </button>
      <button className="ui-icon-button" aria-label={`移除 ${profile.name}`} title={profile.agentCount ? "请先更换关联 Agent 的供应商" : "移除供应商"} disabled={profile.agentCount > 0} onClick={() => { setRemovalError(null); setRemovingProfile(profile); }}><Trash2 size={14} /></button>
      <ProviderSummary protocol="Chat Completions" endpoint={profile.baseUrl} models={[profile.defaultModel, ...profile.models.filter(model => model !== profile.defaultModel)]} />
    </article>)}</div> : <div className="provider-empty"><Cpu size={30} strokeWidth={1.5} /><h4>尚未添加模型供应商</h4></div>}
    <div className="provider-scope"><KeyRound size={14} /><span>全局凭据</span><span>Agent 独立配置优先</span></div>
    {adding ? <AddProviderDialog providers={addable} settings={settings} sources={sources} environmentPresets={environmentPresets} onProfileSaved={profileSaved} onClose={() => setAdding(false)} onSaved={snapshot => { onSaved(snapshot); setAdding(false); setNotice("供应商配置已保存。"); }} /> : null}
    {editingProfile ? <ProviderProfileEditor key={editingProfile.id} profile={editingProfile} preset={findProviderPreset(editingProfile.presetId)} onClose={() => setEditingProfile(null)} onSaved={profileSaved} /> : null}
    <Modal open={Boolean(removingProfile)} onClose={() => setRemovingProfile(null)} title="移除供应商？" size="small" busy={removalBusy}
      footer={<><button className="ui-button" disabled={removalBusy} onClick={() => setRemovingProfile(null)}>取消</button><button className="ui-button ui-button--danger" disabled={removalBusy} onClick={async () => {
        if (!removingProfile || removalBusy) return;
        setRemovalBusy(true); setRemovalError(null);
        try {
          await requestJson("/api/model-providers", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: removingProfile.id }) });
          setProfiles(current => current.filter(item => item.id !== removingProfile.id)); setRemovingProfile(null); setNotice("供应商已移除。");
        } catch (failure) { setRemovalError(failure instanceof Error ? failure.message : "移除供应商失败。"); }
        finally { setRemovalBusy(false); }
      }}>{removalBusy ? "移除中…" : "移除供应商"}</button></>}>
      <p className="text-sm leading-6">将移除 {removingProfile?.name} 的配置和本地凭据。</p>{removalError ? <Feedback>{removalError}</Feedback> : null}
    </Modal>
    {editing ? <ProviderEditor key={editing.id} provider={editing} settings={settings} sources={sources} onClose={() => setEditing(null)} onSaved={snapshot => {
      onSaved(snapshot); setNotice(`${editing.name} 配置已保存。`); setEditing(null);
    }} /> : null}
    <Modal open={removing !== null} onClose={() => setRemoving(null)} title="移除本地配置？" size="small" busy={removalBusy}
      footer={<><button className="ui-button" disabled={removalBusy} onClick={() => setRemoving(null)}>取消</button><button className="ui-button ui-button--danger" disabled={removalBusy} onClick={() => void remove()}>{removalBusy ? "移除中…" : "移除配置"}</button></>}>
      <p className="text-sm leading-6">将移除 {removing?.name} 的本地凭据{removing?.id === "anthropic" ? "和自定义 API 地址" : ""}。环境变量仍会生效，Agent 的独立配置不受影响。</p>
      {removalError ? <Feedback>{removalError}</Feedback> : null}
    </Modal>
  </section>;
}

function ProviderMark({ provider }: { provider: ProviderDefinition }) {
  return <span className={`provider-mark provider-mark--${provider.id}`} aria-hidden="true">{provider.mark}</span>;
}

function ProviderSummary({ protocol, endpoint, models }: { protocol: string; endpoint: string; models: string[] }) {
  return <div className="provider-summary"><div className="provider-model-summary"><span className="provider-protocol-tag">{protocol}</span>
    {models.slice(0, 3).map(model => <code key={model}>{model}</code>)}{models.length > 3 ? <span title={models.slice(3).join(", ")}>+{models.length - 3}</span> : null}
  </div><div className="provider-address"><Globe size={12} /><span>{endpoint}</span></div></div>;
}

function PresetMark({ id }: { id: string }) {
  const family = id.split("-")[0];
  const marks: Record<string, [string, string]> = { glm: ["Z", "blue"], zai: ["Z", "blue"], kimi: ["K", "neutral"], qwen: ["Q", "violet"], mimo: ["Mi", "blue"], minimax: ["M", "red"], longcat: ["L", "green"], stepfun: ["S", "blue"], opencode: ["OC", "neutral"], scnet: ["SC", "red"], nvidia: ["N", "green"], ollama: ["O", "neutral"], huggingface: ["HF", "green"], token: ["TR", "violet"], novita: ["N", "green"], gmi: ["G", "blue"], kilocode: ["Ki", "neutral"] };
  const mark = marks[family];
  return <span className={`provider-mark preset-mark--${mark?.[1] ?? "neutral"}`} aria-hidden="true">{mark?.[0] ?? <Globe size={17} />}</span>;
}

function AddProviderDialog({ providers, settings, sources, onClose, onSaved, onProfileSaved, environmentPresets }: {
  providers: readonly ProviderDefinition[]; settings: ProviderValues; sources: ProviderSources; onClose: () => void; onSaved: (snapshot: ProviderSnapshot) => void;
  onProfileSaved: (profile: ModelProviderProfile) => void; environmentPresets: string[];
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ProviderDefinition | null>(null);
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [group, setGroup] = useState("全部");
  const results = providers.filter(provider => `${provider.name} ${provider.id}`.toLowerCase().includes(query.toLowerCase().trim()));
  const presets = PROVIDER_PRESETS.filter(item => (group === "全部" || item.group === group) && `${item.name} ${item.id} ${item.region} ${item.group} ${item.baseUrl}`.toLowerCase().includes(query.toLowerCase().trim()));
  if (selected) return <ProviderEditor key={selected.id} provider={selected} settings={settings} sources={sources} adding onBack={() => setSelected(null)} onClose={onClose} onSaved={onSaved} />;
  if (preset) return <ProviderProfileEditor key={preset.id} preset={preset} hasEnvironmentKey={environmentPresets.includes(preset.id)} onBack={() => setPreset(null)} onClose={onClose} onSaved={onProfileSaved} />;
  return <Modal open title="添加模型供应商" onClose={onClose} size="wide" className="provider-picker"
    footer={<button className="ui-button" onClick={onClose}>取消</button>}
    navigation={<div className="provider-picker-nav"><label className="provider-search"><Search size={15} /><input data-autofocus aria-label="搜索供应商" placeholder="搜索供应商…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <nav className="provider-catalog-tabs" aria-label="供应商分类">{["全部", "官方 API", "Coding Plan", "聚合平台", "自定义"].map(item => <button key={item} aria-pressed={group === item} onClick={() => setGroup(item)}>{item}</button>)}</nav></div>}>
    <div className="provider-catalog">{(group === "全部" || group === "官方 API") && results.length ? <h3>内置供应商</h3> : null}{group === "全部" || group === "官方 API" ? results.map(provider => <button key={provider.id} onClick={() => setSelected(provider)} aria-label={`添加 ${provider.name}`}>
      <ProviderMark provider={provider} /><span><strong>{provider.name}</strong><small>{provider.protocol}</small></span><ChevronRight size={15} />
    </button>) : null}
    {["官方 API", "Coding Plan", "聚合平台", "自定义"].map(category => {
      const entries = presets.filter(item => item.group === category);
      return entries.length ? <PresetGroup key={category} title={category} entries={entries} onSelect={setPreset} /> : null;
    })}</div>
    {!presets.length && (!results.length || !["全部", "官方 API"].includes(group)) ? <p className="provider-search-empty">没有匹配的供应商</p> : null}
  </Modal>;
}

function PresetGroup({ title, entries, onSelect }: { title: string; entries: ProviderPreset[]; onSelect: (preset: ProviderPreset) => void }) {
  return <><h3>{title}<span>{entries.length}</span></h3>{entries.map(item => <button key={item.id} aria-label={`添加 ${item.name} ${item.region}`} onClick={() => onSelect(item)}>
    <PresetMark id={item.id} /><span><strong>{item.name}</strong><small>{item.region} · {item.models[0] ?? "Chat Completions"}</small></span><ChevronRight size={15} />
  </button>)}</>;
}

function ProviderEditor({ provider, settings, sources, adding = false, onBack, onClose, onSaved }: {
  provider: ProviderDefinition; settings: ProviderValues; sources: ProviderSources; adding?: boolean;
  onBack?: () => void; onClose: () => void; onSaved: (snapshot: ProviderSnapshot) => void;
}) {
  const [keyDraft, setKeyDraft] = useState("");
  const [baseUrl, setBaseUrl] = useState(settings.anthropicBaseUrl ?? "");
  const [showKey, setShowKey] = useState(false);
  const [testModel, setTestModel] = useState(provider.testModel ?? "");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const testController = useRef<AbortController | null>(null);
  useEffect(() => () => testController.current?.abort(), []);
  const source = providerSource(provider, settings, sources);
  const patch = useMemo(() => providerPatch(provider, keyDraft, baseUrl, settings), [provider, keyDraft, baseUrl, settings]);
  const dirty = Object.keys(patch).length > 0;
  const busy = saving || testing;
  let validation: string | null = null;
  if (/[\r\n]/.test(keyDraft.trim())) validation = "API Key 不能包含换行。";
  if (provider.id === "anthropic" && baseUrl.trim()) {
    try { if (!["http:", "https:"].includes(new URL(baseUrl.trim()).protocol)) validation = "API 地址必须使用 HTTP 或 HTTPS。"; }
    catch { validation = "请输入有效的 API 地址。"; }
  }
  const validCredential = Boolean(keyDraft.trim()) || source !== "missing";
  const close = useUnsavedChanges(dirty, onClose, busy);
  const back = useUnsavedChanges(dirty, onBack ?? onClose, busy);
  const save = async () => {
    if (busy || validation || !validCredential || !dirty) return;
    setSaving(true); setError(null);
    try {
      const snapshot = await requestJson<ProviderSnapshot>("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      if (!snapshot.settings || !snapshot.keySources) throw new Error("配置已提交，但供应商状态读取失败，请重新打开设置确认。");
      onSaved(snapshot);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存供应商失败。"); }
    finally { setSaving(false); }
  };
  const test = async () => {
    if (busy || validation || !validCredential || !provider.testModel) return;
    setTesting(true); setTestResult(null);
    const controller = new AbortController(); testController.current = controller;
    try {
      const result = await requestJson<{ ok: boolean; latencyMs?: number; error?: string }>("/api/settings/test-connection", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ provider: provider.id, ...(testModel.trim() ? { modelId: testModel.trim() } : {}), ...(keyDraft.trim() ? { apiKey: keyDraft.trim() } : {}) })
      });
      setTestResult(result.ok ? { ok: true, message: `连接成功${result.latencyMs !== undefined ? `，${result.latencyMs} ms` : ""}` } : { ok: false, message: result.error ?? "连接失败。" });
    } catch (failure) { if (!controller.signal.aborted) setTestResult({ ok: false, message: failure instanceof Error ? failure.message : "连接失败。" }); }
    finally { if (!controller.signal.aborted) setTesting(false); }
  };
  return <>
    <Modal open title={`${adding ? "添加" : "配置"} ${provider.name}`} onClose={close.requestClose} size="medium" busy={busy} className="provider-editor"
      footer={<>{error ? <Feedback>{error}</Feedback> : null}
        {onBack ? <button className="ui-button ui-button--quiet mr-auto" disabled={busy} onClick={back.requestClose}><ArrowLeft size={14} />返回</button> : null}
        <button className="ui-button" disabled={busy} onClick={close.requestClose}>取消</button>
        <button className="ui-button ui-button--primary" disabled={busy || !dirty || !validCredential || Boolean(validation)} onClick={() => void save()}>{saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}{saving ? "保存中…" : "保存供应商"}</button>
      </>}>
      <div className="provider-editor-identity"><ProviderMark provider={provider} /><div><strong>{provider.name}</strong><span>{provider.protocol}</span></div>
        <span className="provider-editor-source">{source === "app_settings" ? "已保存凭据" : source === "environment" ? "环境变量" : "未配置"}</span></div>
      <label className="ui-field"><span className="ui-field-label">API Key</span><span className="provider-key-input"><input data-autofocus aria-label={`${provider.name} API Key`} type={showKey ? "text" : "password"} autoComplete="new-password" spellCheck={false}
        placeholder={source === "missing" ? "输入 API Key" : "留空保留现有凭据"} value={keyDraft} onChange={event => { setKeyDraft(event.target.value); setTestResult(null); setError(null); }} />
        <button type="button" className="ui-icon-button" aria-label={showKey ? "隐藏新输入的密钥" : "显示新输入的密钥"} title={showKey ? "隐藏" : "显示"} onClick={() => setShowKey(current => !current)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></span></label>
      {validation ? <Feedback>{validation}</Feedback> : null}
      <div className="provider-endpoint"><Globe size={14} /><span>{provider.id === "anthropic" && baseUrl.trim() ? baseUrl.trim() : provider.endpoint}</span></div>
      {provider.id === "anthropic" ? <details className="provider-advanced"><summary>自定义设置</summary><label className="ui-field"><span className="ui-field-label">API 地址</span><input aria-label="Anthropic API 地址" type="url" value={baseUrl} placeholder={provider.endpoint} onChange={event => setBaseUrl(event.target.value)} /></label></details> : null}
      {provider.testModel ? <details className="provider-advanced"><summary>连接诊断</summary><label className="ui-field"><span className="ui-field-label">测试模型</span><input aria-label="测试模型" value={testModel} onChange={event => { setTestModel(event.target.value); setTestResult(null); }} /></label></details> : null}
      {provider.testModel ? <div className="provider-test"><button className="ui-button ui-button--quiet" disabled={busy || !validCredential || Boolean(validation)} onClick={() => void test()}>{testing ? <Loader2 size={14} className="animate-spin" /> : <TestTube2 size={14} />}{testing ? "测试中…" : "测试连接"}</button>
        {testResult ? <Feedback tone={testResult.ok ? "success" : "error"}>{testResult.message}</Feedback> : null}</div> : null}
    </Modal>
    {close.confirmation}{back.confirmation}
  </>;
}
