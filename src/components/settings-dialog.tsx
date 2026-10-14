"use client";

import { CheckCircle2, Cpu, Eye, EyeOff, Globe, Loader2, MessageSquare, TestTube2, Trash2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { ChannelBindingsPanel } from "@/components/channel-bindings-panel";
import { Modal, useUnsavedChanges } from "@/components/ui/modal";
import { Feedback, SectionHeading } from "@/components/ui/controls";

interface SettingsData {
  openaiApiKey: string | null;
  deepseekApiKey: string | null;
  arkApiKey: string | null;
  anthropicApiKey: string | null;
  anthropicBaseUrl: string | null;
  deploymentPublishEnabled: boolean;
  deploymentPublishDir: string | null;
  deploymentPublicBaseUrl: string | null;
}

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

type ApiKeySetting =
  | "openaiApiKey"
  | "deepseekApiKey"
  | "arkApiKey"
  | "anthropicApiKey";

type ApiKeySource = "app_settings" | "environment" | "missing";

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const [settings, setSettings] = useState<SettingsData>({
    openaiApiKey: null,
    deepseekApiKey: null,
    arkApiKey: null,
    anthropicApiKey: null,
    anthropicBaseUrl: null,
    deploymentPublishEnabled: false,
    deploymentPublishDir: null,
    deploymentPublicBaseUrl: null
  });
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [dirtyKeys, setDirtyKeys] = useState<Record<string, boolean>>({});
  const [keySources, setKeySources] = useState<Record<string, ApiKeySource>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tab, setTab] = useState("models");
  const [baseline, setBaseline] = useState("");
  const [loadVersion, setLoadVersion] = useState(0);
  const discard = useUnsavedChanges(Boolean(baseline && JSON.stringify(settings) !== baseline), onClose, saving);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal })
      .then(async (r) => {
        setLoadError(null);
        const data = await r.json() as {
          settings?: SettingsData;
          keySources?: Record<string, ApiKeySource>;
          error?: string;
        };
        if (controller.signal.aborted) return;
        if (!r.ok || !data.settings) throw new Error(data.error ?? "加载设置失败。");
        setSettings(data.settings);
        setBaseline(JSON.stringify(data.settings));
        setKeySources(data.keySources ?? {});
        setDirtyKeys({});
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : "加载设置失败。");
      });
    return () => controller.abort();
  }, [open, loadVersion]);

  if (!open) return null;

  const toggleShow = (key: string) => {
    setShowKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSave = async () => {
    if (saving || !baseline) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anthropicBaseUrl: settings.anthropicBaseUrl,
          deploymentPublishEnabled: settings.deploymentPublishEnabled,
          deploymentPublishDir: settings.deploymentPublishDir,
          deploymentPublicBaseUrl: settings.deploymentPublicBaseUrl,
          ...Object.fromEntries(
            (["openaiApiKey", "deepseekApiKey", "arkApiKey", "anthropicApiKey"] as const)
              .filter((key) => dirtyKeys[key])
              .map((key) => [key, settings[key]])
          )
        })
      });
      const data = await response.json().catch(() => ({})) as { error?: unknown };
      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "保存设置失败。");
      }
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存设置失败。");
    } finally {
      setSaving(false);
    }
  };

  const handleTestDeepSeek = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch("/api/settings/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "deepseek",
          modelId: "deepseek-chat",
          ...(dirtyKeys.deepseekApiKey && settings.deepseekApiKey
            ? { apiKey: settings.deepseekApiKey }
            : {})
        })
      });
      const data = await response.json() as {
        ok: boolean;
        latencyMs?: number;
        error?: string;
      };
      setTestResult(data.ok
        ? { ok: true, message: `连接成功${data.latencyMs ? `，${data.latencyMs} ms` : ""}` }
        : { ok: false, message: data.error ?? "连接失败。" });
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : "连接失败。"
      });
    } finally {
      setTesting(false);
    }
  };

  const renderKeyField = (label: string, key: ApiKeySetting, envVar: string) => (
    <div className="ui-key-field">
      <label htmlFor={`settings-${key}`} className="ui-field-label">{label}</label>
      <div className="mt-1 flex gap-2">
        <input
          id={`settings-${key}`}
          type={showKeys[key] ? "text" : "password"}
          className="h-9 flex-1 rounded-md border border-stone-300 px-3 text-sm font-mono outline-none focus:border-stone-500"
          placeholder="API Key"
          value={settings[key] ?? ""}
          onChange={(e) => {
            setDirtyKeys((current) => ({ ...current, [key]: true }));
            setSettings({ ...settings, [key]: e.target.value || null });
          }}
        />
        <button
          onClick={() => toggleShow(key)}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-stone-200 text-stone-500 hover:bg-stone-50"
          title={showKeys[key] ? "隐藏" : "显示"}
        >
          {showKeys[key] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={() => {
            setDirtyKeys((current) => ({ ...current, [key]: true }));
            setSettings({ ...settings, [key]: null });
          }}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-stone-200 text-stone-400 hover:bg-red-50 hover:text-red-600"
          title="清除已保存 Key"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <p className="mt-1 text-xs text-stone-400">
        {dirtyKeys[key] ? "保存后更新此凭据" : envVar}
      </p>
      <p className="mt-1 text-xs text-stone-500">
        当前来源：{formatKeySource(keySources[keyToProvider(key)])}
      </p>
    </div>
  );

  return (
    <><Modal open={open} onClose={discard.requestClose} title="设置" description="工作空间配置" size="wide" busy={saving}
      footer={<>{saveError ? <Feedback>{saveError}</Feedback> : null}
        <button className="ui-button ui-button--quiet" onClick={discard.requestClose} disabled={saving}>取消</button>
        <button className="ui-button ui-button--primary" onClick={() => void handleSave()} disabled={saving || !baseline}>{saving ? <Loader2 size={16} className="animate-spin" /> : null}{saving ? "保存中..." : "保存设置"}</button></>}>
      <div className="ui-settings-layout ui-form">
        <nav className="ui-settings-rail" aria-label="设置分类">
          {[{ id: "models", label: "模型与凭据", icon: <Cpu size={16} /> }, { id: "channels", label: "渠道绑定", icon: <MessageSquare size={16} /> }, { id: "publishing", label: "发布与预览", icon: <Globe size={16} /> }].map(item =>
            <button key={item.id} aria-current={tab === item.id} onClick={() => setTab(item.id)}>{item.icon}{item.label}</button>)}
        </nav>
        <div className="min-w-0">
        {loadError ? <div className="mb-4 space-y-2"><Feedback>{loadError}</Feedback><button className="ui-button" onClick={() => setLoadVersion(value => value + 1)}>重新加载</button></div> : !baseline ? <p role="status" className="ui-muted mb-4">正在读取设置...</p> : null}
        <fieldset hidden={tab !== "models"} disabled={!baseline || saving}>
        <SectionHeading title="模型与凭据" detail="Agent 可单独覆盖全局凭据。未修改的 Key 会保留现有值。" />

        {renderKeyField("DeepSeek API Key", "deepseekApiKey", "DEEPSEEK_API_KEY")}
        {renderKeyField("OpenAI API Key", "openaiApiKey", "OPENAI_API_KEY")}
        {renderKeyField("火山方舟 API Key", "arkApiKey", "ARK_API_KEY")}
        {renderKeyField("Anthropic API Key", "anthropicApiKey", "ANTHROPIC_API_KEY")}

        <div className="mt-4 border-t border-[var(--ui-line)] pt-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-800">DeepSeek 诊断</div>
              <p className="mt-1 text-xs text-slate-500">使用当前输入或已保存/环境变量 Key 测试 `deepseek-chat`。</p>
            </div>
            <button
              type="button"
              onClick={handleTestDeepSeek}
              disabled={testing}
              className="flex h-9 shrink-0 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-60"
            >
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <TestTube2 className="h-4 w-4" />}
              测试连接
            </button>
          </div>
          {testResult ? (
            <div className={`mt-3 flex items-start gap-2 text-xs ${testResult.ok ? "text-emerald-700" : "text-red-700"}`}>
              {testResult.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
              <span className="break-all leading-5">{testResult.message}</span>
            </div>
          ) : null}
        </div>

        <div className="mt-4">
          <label className="block text-sm font-medium text-stone-700">Anthropic Base URL（可选）</label>
          <input
            type="text"
            className="mt-1 h-9 w-full rounded-md border border-stone-300 px-3 text-sm outline-none focus:border-stone-500"
            placeholder="留空使用默认"
            value={settings.anthropicBaseUrl ?? ""}
            onChange={(e) => setSettings({ ...settings, anthropicBaseUrl: e.target.value || null })}
          />
        </div>

        </fieldset>
        <fieldset hidden={tab !== "publishing"} disabled={!baseline || saving}>
        <SectionHeading title="发布与预览" detail="同步部署文件到指定目录，公网服务由你自行管理。" />
        <div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-stone-800">外部静态发布</div>
              <p className="mt-1 text-xs leading-5 text-stone-500">
                同步部署文件到指定目录；AgentMeld 不负责启动公网服务器。
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.deploymentPublishEnabled}
              onClick={() => setSettings({
                ...settings,
                deploymentPublishEnabled: !settings.deploymentPublishEnabled
              })}
              className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                settings.deploymentPublishEnabled ? "bg-blue-600" : "bg-stone-300"
              }`}
              title={settings.deploymentPublishEnabled ? "关闭外部发布" : "开启外部发布"}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${
                  settings.deploymentPublishEnabled ? "left-[22px]" : "left-0.5"
                }`}
              />
            </button>
          </div>

          {settings.deploymentPublishEnabled ? (
            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-stone-700">发布根目录</label>
                <input
                  type="text"
                  className="mt-1 h-9 w-full rounded-md border border-stone-300 px-3 text-sm outline-none focus:border-stone-500"
                  placeholder="例如 D:\sites\agentmeld"
                  value={settings.deploymentPublishDir ?? ""}
                  onChange={(event) => setSettings({
                    ...settings,
                    deploymentPublishDir: event.target.value || null
                  })}
                />
                <p className="mt-1 text-xs text-stone-400">每次发布只写入该目录下独立的 deployment id 子目录。</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700">公开 Base URL</label>
                <input
                  type="url"
                  className="mt-1 h-9 w-full rounded-md border border-stone-300 px-3 text-sm outline-none focus:border-stone-500"
                  placeholder="https://example.com/apps/"
                  value={settings.deploymentPublicBaseUrl ?? ""}
                  onChange={(event) => setSettings({
                    ...settings,
                    deploymentPublicBaseUrl: event.target.value || null
                  })}
                />
              </div>
            </div>
          ) : null}
        </div>

        </fieldset>
          <section hidden={tab !== "channels"}>
          <ChannelBindingsPanel />
          </section>

        </div>

      </div>
    </Modal>{discard.confirmation}</>
  );
}

function keyToProvider(key: ApiKeySetting) {
  if (key === "deepseekApiKey") return "deepseek";
  if (key === "openaiApiKey") return "openai";
  if (key === "arkApiKey") return "volcano-ark";
  return "anthropic";
}

function formatKeySource(source: ApiKeySource | undefined) {
  if (source === "app_settings") return "全局设置";
  if (source === "environment") return "环境变量";
  return "未配置（Agent 单独 Key 仍可覆盖）";
}
