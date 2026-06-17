"use client";

import { Eye, EyeOff, X } from "lucide-react";
import { useEffect, useState } from "react";

interface SettingsData {
  openaiApiKey: string | null;
  deepseekApiKey: string | null;
  arkApiKey: string | null;
  anthropicApiKey: string | null;
  anthropicBaseUrl: string | null;
}

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const [settings, setSettings] = useState<SettingsData>({
    openaiApiKey: null,
    deepseekApiKey: null,
    arkApiKey: null,
    anthropicApiKey: null,
    anthropicBaseUrl: null
  });
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setSettings(data.settings);
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
        body: JSON.stringify(settings)
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const renderKeyField = (label: string, key: keyof SettingsData, envVar: string) => (
    <div className="mt-4">
      <label className="block text-sm font-medium text-stone-700">{label}</label>
      <div className="mt-1 flex gap-2">
        <input
          type={showKeys[key] ? "text" : "password"}
          className="h-9 flex-1 rounded-md border border-stone-300 px-3 text-sm font-mono outline-none focus:border-stone-500"
          placeholder={`留空使用环境变量 ${envVar}`}
          value={settings[key] ?? ""}
          onChange={(e) => setSettings({ ...settings, [key]: e.target.value || null })}
        />
        <button
          onClick={() => toggleShow(key)}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-stone-200 text-stone-500 hover:bg-stone-50"
          title={showKeys[key] ? "隐藏" : "显示"}
        >
          {showKeys[key] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/30 px-4">
      <div className="w-full max-w-md rounded-lg border border-stone-200 bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-stone-950">设置</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-md text-stone-400 hover:bg-stone-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mt-2 text-sm text-stone-500">
          配置 API Key 后，所有 Agent 共享使用。Agent 编辑页可单独覆盖 Key。
        </p>

        {renderKeyField("OpenAI API Key", "openaiApiKey", "OPENAI_API_KEY")}
        {renderKeyField("DeepSeek API Key", "deepseekApiKey", "DEEPSEEK_API_KEY")}
        {renderKeyField("火山方舟 API Key", "arkApiKey", "ARK_API_KEY")}
        {renderKeyField("Anthropic API Key", "anthropicApiKey", "ANTHROPIC_API_KEY")}

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

        <div className="mt-6 flex justify-end gap-3">
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
