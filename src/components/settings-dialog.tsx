"use client";

import { Cpu, Globe, Loader2, MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { ChannelBindingsPanel } from "@/components/channel-bindings-panel";
import { ModelProviderSettings } from "@/components/model-provider-settings";
import { Modal, useUnsavedChanges } from "@/components/ui/modal";
import { Feedback, SectionHeading } from "@/components/ui/controls";
import { mergeProviderValues, type ProviderSnapshot, type ProviderSources, type ProviderValues } from "@/lib/model-provider-settings";
import { requestJson } from "@/lib/request-json";

interface SettingsData extends ProviderValues {
  deploymentPublishEnabled: boolean;
  deploymentPublishDir: string | null;
  deploymentPublicBaseUrl: string | null;
}

const EMPTY_SETTINGS: SettingsData = {
  openaiApiKey: null, deepseekApiKey: null, arkApiKey: null, anthropicApiKey: null, anthropicBaseUrl: null,
  deploymentPublishEnabled: false, deploymentPublishDir: null, deploymentPublicBaseUrl: null
};

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [settings, setSettings] = useState<SettingsData>(EMPTY_SETTINGS);
  const [baseline, setBaseline] = useState<SettingsData | null>(null);
  const [sources, setSources] = useState<ProviderSources>({});
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tab, setTab] = useState("models");
  const [loadVersion, setLoadVersion] = useState(0);
  const dirty = Boolean(baseline && JSON.stringify(settings) !== JSON.stringify(baseline));
  const discard = useUnsavedChanges(dirty, onClose, saving);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    requestJson<{ settings: SettingsData; keySources: ProviderSources }>("/api/settings", { signal: controller.signal })
      .then(data => {
        if (controller.signal.aborted) return;
        if (!data.settings) throw new Error("加载设置失败。");
        setSettings(data.settings); setBaseline(data.settings); setSources(data.keySources ?? {}); setLoadError(null);
      })
      .catch(failure => { if (!controller.signal.aborted) setLoadError(failure instanceof Error ? failure.message : "加载设置失败。"); });
    return () => controller.abort();
  }, [open, loadVersion]);

  if (!open) return null;

  const providerSaved = (snapshot: ProviderSnapshot) => {
    setSettings(current => mergeProviderValues(current, snapshot.settings));
    setBaseline(current => current ? mergeProviderValues(current, snapshot.settings) : current);
    setSources(snapshot.keySources);
  };
  const save = async () => {
    if (saving || !baseline || !dirty) return;
    setSaving(true); setSaveError(null);
    try {
      await requestJson("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        deploymentPublishEnabled: settings.deploymentPublishEnabled, deploymentPublishDir: settings.deploymentPublishDir,
        deploymentPublicBaseUrl: settings.deploymentPublicBaseUrl
      }) });
      onClose();
    } catch (failure) { setSaveError(failure instanceof Error ? failure.message : "保存设置失败。"); }
    finally { setSaving(false); }
  };

  return <>
    <Modal open onClose={discard.requestClose} title="设置" size="wide" busy={saving} className="provider-settings-dialog"
      footer={<>{saveError ? <Feedback>{saveError}</Feedback> : null}
        <button className="ui-button ui-button--quiet" onClick={discard.requestClose} disabled={saving}>{dirty ? "取消" : "完成"}</button>
        {tab === "publishing" || dirty ? <button className="ui-button ui-button--primary" disabled={saving || !baseline || !dirty} onClick={() => void save()}>{saving ? <Loader2 size={15} className="animate-spin" /> : null}{saving ? "保存中…" : "保存设置"}</button> : null}
      </>}>
      <div className="ui-settings-layout">
        <nav className="ui-settings-rail" aria-label="设置分类">
          <div className="settings-rail-label">工作空间</div>
          {[{ id: "models", label: "模型供应商", icon: <Cpu size={16} /> }, { id: "channels", label: "渠道绑定", icon: <MessageSquare size={16} /> }, { id: "publishing", label: "发布与预览", icon: <Globe size={16} /> }].map(item =>
            <button key={item.id} aria-current={tab === item.id} onClick={() => setTab(item.id)}>{item.icon}{item.label}</button>)}
        </nav>
        <div className="min-w-0">
          {loadError ? <div className="space-y-3"><Feedback>{loadError}</Feedback><button className="ui-button" onClick={() => { setLoadError(null); setBaseline(null); setLoadVersion(value => value + 1); }}>重新加载</button></div>
            : !baseline ? <p role="status" className="ui-muted">正在读取设置…</p> : <>
              <section hidden={tab !== "models"}><ModelProviderSettings settings={settings} sources={sources} onSaved={providerSaved} /></section>
              <fieldset hidden={tab !== "publishing"} disabled={saving}>
                <SectionHeading title="发布与预览" />
                <div className="publishing-setting-row"><span>外部静态发布</span><button type="button" role="switch" aria-label="外部静态发布" aria-checked={settings.deploymentPublishEnabled}
                  onClick={() => setSettings(current => ({ ...current, deploymentPublishEnabled: !current.deploymentPublishEnabled }))}
                  className={`publishing-toggle ${settings.deploymentPublishEnabled ? "is-on" : ""}`}><span /></button></div>
                {settings.deploymentPublishEnabled ? <div className="mt-5">
                  <label className="ui-field"><span className="ui-field-label">发布根目录</span><input value={settings.deploymentPublishDir ?? ""} placeholder="例如 D:\sites\agentmeld" onChange={event => setSettings(current => ({ ...current, deploymentPublishDir: event.target.value || null }))} /></label>
                  <label className="ui-field"><span className="ui-field-label">公开 Base URL</span><input type="url" value={settings.deploymentPublicBaseUrl ?? ""} placeholder="https://example.com/apps/" onChange={event => setSettings(current => ({ ...current, deploymentPublicBaseUrl: event.target.value || null }))} /></label>
                </div> : null}
              </fieldset>
            </>}
          <section hidden={tab !== "channels"}><ChannelBindingsPanel /></section>
        </div>
      </div>
    </Modal>
    {discard.confirmation}
  </>;
}
