"use client";

import { CheckCircle2, Eye, EyeOff, KeyRound, Loader2, TestTube2, Trash2, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

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

  useEffect(() => {
    if (!open) return;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setSettings(data.settings);
        setKeySources(data.keySources ?? {});
        setDirtyKeys({});
      })
      .catch(() => {});
  }, [open]);

  if (!open) return null;

  const toggleShow = (key: string) => {
    setShowKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch("/api/settings", {
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
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleTestDeepSeek = async () => {
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

  const renderKeyField = (label: string, key: ApiKeySetting, envVar: string, prominent = false) => (
    <div className={`mt-4 rounded-md ${prominent ? "border border-blue-200 bg-blue-50 p-3" : ""}`}>
      <label className="block text-sm font-medium text-stone-700">{label}</label>
      <div className="mt-1 flex gap-2">
        <input
          type={showKeys[key] ? "text" : "password"}
          className="h-9 flex-1 rounded-md border border-stone-300 px-3 text-sm font-mono outline-none focus:border-stone-500"
          placeholder={`留空使用环境变量 ${envVar}`}
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
        {dirtyKeys[key] ? "此字段将在保存时更新。" : `未修改时保留现有值；也可使用 ${envVar}。`}
      </p>
      <p className="mt-1 text-xs text-stone-500">
        当前来源：{formatKeySource(keySources[keyToProvider(key)])}
      </p>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/30 px-4">
      <div className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-stone-200 bg-white shadow-2xl">
        <div className="min-h-0 flex-1 overflow-y-auto p-6 pb-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-stone-950">设置</h2>
            <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-md text-stone-400 hover:bg-stone-100">
              <X className="h-5 w-5" />
            </button>
          </div>

        <p className="mt-2 text-sm text-stone-500">
          配置 API Key 后，所有 Agent 共享使用。Agent 编辑页可单独覆盖 Key。
        </p>

        <div className="mt-4 flex items-center gap-2 text-sm font-medium text-blue-800">
          <KeyRound className="h-4 w-4" />
          当前 Web MVP 默认使用 DeepSeek
        </div>

        {renderKeyField("DeepSeek API Key", "deepseekApiKey", "DEEPSEEK_API_KEY", true)}
        {renderKeyField("OpenAI API Key", "openaiApiKey", "OPENAI_API_KEY")}
        {renderKeyField("火山方舟 API Key", "arkApiKey", "ARK_API_KEY")}
        {renderKeyField("Anthropic API Key", "anthropicApiKey", "ANTHROPIC_API_KEY")}

        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
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

        <div className="mt-6 border-t border-stone-200 pt-5">
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

        </div>

        <div className="flex shrink-0 justify-end gap-3 border-t border-stone-200 bg-white px-6 py-4">
          <button onClick={onClose} className="h-9 rounded-md px-4 text-sm text-stone-600 hover:bg-stone-100">
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="h-9 rounded-md bg-stone-950 px-4 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
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
