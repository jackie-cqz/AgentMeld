"use client";

import { ArrowLeft, Check, Eye, EyeOff, Loader2, TestTube2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, useUnsavedChanges } from "@/components/ui/modal";
import { Feedback } from "@/components/ui/controls";
import { requestJson } from "@/lib/request-json";
import { providerProfileInputSchema } from "@/shared/model-provider-schema";
import { profileProviderId, type ProviderPreset } from "@/shared/provider-presets";
import type { ModelProviderProfile } from "@/shared/types";

export function ProviderProfileEditor({ preset, profile, hasEnvironmentKey = false, onClose, onBack, onSaved }: {
  preset?: ProviderPreset; profile?: ModelProviderProfile; hasEnvironmentKey?: boolean;
  onClose: () => void; onBack?: () => void; onSaved: (profile: ModelProviderProfile) => void;
}) {
  const initial = useMemo(() => ({ name: profile?.name ?? `${preset?.name ?? ""}${preset && preset.group !== "自定义" ? ` · ${preset.region}` : ""}`,
    baseUrl: profile?.baseUrl ?? preset?.baseUrl ?? "", defaultModel: profile?.defaultModel ?? preset?.models[0] ?? "",
    modelsText: (profile?.models ?? preset?.models ?? []).join("\n") }), [profile, preset]);
  const [fields, setFields] = useState(initial);
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const source = profile?.credentialSource ?? (hasEnvironmentKey ? "environment" : "missing");
  const dirty = keyDraft !== "" || JSON.stringify(fields) !== JSON.stringify(initial);
  const busy = saving || testing;
  const close = useUnsavedChanges(dirty, onClose, busy);
  const back = useUnsavedChanges(dirty, onBack ?? onClose, busy);
  const payload = { name: fields.name, baseUrl: fields.baseUrl, defaultModel: fields.defaultModel,
    models: [...new Set(fields.modelsText.split(/\r?\n/).map(model => model.trim()).filter(Boolean))],
    protocol: "chat-completions" as const, presetId: profile?.presetId ?? preset?.id ?? null,
    ...(keyDraft.trim() ? { apiKey: keyDraft.trim() } : {}) };
  const parsed = providerProfileInputSchema.safeParse(payload);
  const valid = parsed.success && (Boolean(keyDraft.trim()) || source !== "missing");
  const update = (key: keyof typeof fields, value: string) => { setFields(current => ({ ...current, [key]: value })); setTestResult(null); setError(null); };

  const save = async () => {
    if (busy || !valid || (profile && !dirty)) return;
    setSaving(true); setError(null);
    try {
      const result = await requestJson<{ provider: ModelProviderProfile }>("/api/model-providers", {
        method: profile ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...parsed.data, ...(profile ? { id: profile.id } : {}) })
      });
      if (!result.provider?.id) throw new Error("未收到供应商保存结果，请重新加载确认。");
      onSaved(result.provider);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存供应商失败。"); }
    finally { setSaving(false); }
  };
  const test = async () => {
    if (!valid || busy) return;
    setTesting(true); setTestResult(null);
    const abort = new AbortController(); controller.current = abort;
    try {
      const result = await requestJson<{ ok: boolean; error?: string; latencyMs?: number }>("/api/settings/test-connection", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: abort.signal,
        body: JSON.stringify({ provider: profile ? profileProviderId(profile.id) : "openai-compatible", presetId: payload.presetId ?? undefined,
          apiBaseUrl: fields.baseUrl.trim(), modelId: fields.defaultModel.trim(), ...(keyDraft.trim() ? { apiKey: keyDraft.trim() } : {}) })
      });
      setTestResult({ ok: result.ok, message: result.ok ? `连接成功，${result.latencyMs ?? 0} ms` : result.error ?? "连接失败。" });
    } catch (failure) { if (!abort.signal.aborted) setTestResult({ ok: false, message: failure instanceof Error ? failure.message : "连接失败。" }); }
    finally { if (!abort.signal.aborted) setTesting(false); }
  };

  return <>
    <Modal open title={`${profile ? "配置" : "添加"} ${profile?.name ?? preset?.name ?? "供应商"}`} size="medium" className="provider-editor" busy={busy} onClose={close.requestClose}
      footer={<>{error ? <Feedback>{error}</Feedback> : null}
        {onBack ? <button className="ui-button ui-button--quiet mr-auto" disabled={busy} onClick={back.requestClose}><ArrowLeft size={14} />返回</button> : null}
        <button className="ui-button" disabled={busy} onClick={close.requestClose}>取消</button>
        <button className="ui-button ui-button--primary" disabled={busy || !valid || Boolean(profile && !dirty)} onClick={() => void save()}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}{saving ? "保存中…" : "保存供应商"}</button>
      </>}>
      <div className="provider-profile-meta"><span className="provider-protocol-tag">Chat Completions</span><span>{preset?.group ?? "自定义"}{preset ? ` · ${preset.region}` : ""}</span></div>
      <div className="provider-form-grid">
      <label className="ui-field"><span className="ui-field-label">配置名称</span><input data-autofocus aria-label="配置名称" value={fields.name} maxLength={80} onChange={event => update("name", event.target.value)} /></label>
      <label className="ui-field"><span className="ui-field-label">默认模型</span><input list="provider-profile-models" aria-label="默认模型" value={fields.defaultModel} onChange={event => update("defaultModel", event.target.value)} />
        <datalist id="provider-profile-models">{payload.models.map(model => <option key={model} value={model} />)}</datalist></label>
      <label className="ui-field provider-field-full"><span className="ui-field-label">API 地址</span><input type="url" aria-label="供应商 API 地址" placeholder="https://api.example.com/v1" value={fields.baseUrl} onChange={event => update("baseUrl", event.target.value)} /></label>
      <label className="ui-field provider-field-full"><span className="ui-field-label">API Key{source === "environment" ? ` · ${preset?.envKey ?? "环境变量"}` : source === "app_settings" ? " · 已保存" : ""}</span>
        <span className="provider-key-input"><input aria-label="供应商 API Key" autoComplete="new-password" spellCheck={false} type={showKey ? "text" : "password"} value={keyDraft}
          placeholder={source === "missing" ? "输入 API Key" : "留空保留现有凭据"} onChange={event => { setKeyDraft(event.target.value); setTestResult(null); setError(null); }} />
          <button className="ui-icon-button" title={showKey ? "隐藏密钥" : "显示密钥"} aria-label={showKey ? "隐藏新输入的密钥" : "显示新输入的密钥"} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></span>
      </label>
      </div>
      <details className="provider-advanced"><summary>模型列表 · {payload.models.length}</summary><label className="ui-field"><span className="ui-field-label">模型 ID（每行一个）</span><textarea aria-label="模型列表" rows={5} value={fields.modelsText} onChange={event => update("modelsText", event.target.value)} /></label></details>
      {dirty && !parsed.success ? <Feedback>{parsed.error.issues[0]?.message}</Feedback> : null}
      <div className="provider-test"><button className="ui-button ui-button--quiet" disabled={busy || !valid} onClick={() => void test()}>{testing ? <Loader2 size={14} className="animate-spin" /> : <TestTube2 size={14} />}{testing ? "测试中…" : "测试连接"}</button>
        {testResult ? <Feedback tone={testResult.ok ? "success" : "error"}>{testResult.message}</Feedback> : null}</div>
    </Modal>
    {close.confirmation}{back.confirmation}
  </>;
}
