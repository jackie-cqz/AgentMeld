"use client";

import { Loader2, X } from "lucide-react";
import { useState } from "react";
import { requestJson } from "@/lib/request-json";
import { getAgentAvatarStyle } from "@/shared/agent-avatar";
import { useAppStore } from "@/stores/app-store";
import type { Conversation } from "@/shared/types";

export function ConversationAgentManagerDialog({
  conversation,
  open,
  onClose
}: {
  conversation: Conversation;
  open: boolean;
  onClose: () => void;
}) {
  const agents = useAppStore((state) => state.agents);
  const updateConversation = useAppStore((state) => state.updateConversation);
  const [selected, setSelected] = useState<string[]>(conversation.agentIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const toggle = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((agentId) => agentId !== id) : [...current, id]
    );
  };

  const save = async () => {
    if (selected.length === 0) {
      setError("至少保留一个 Agent。");
      return;
    }
    const conductors = selected.filter((id) => agents[id]?.isConductor);
    if (conductors.length > 1) {
      setError("一个会话最多只能包含一个 Conductor。");
      return;
    }
    const mode = selected.length === 1 ? "single" : "group";
    setSaving(true);
    setError(null);
    try {
      const data = await requestJson<{ conversation: Conversation }>(
        `/api/conversations/${conversation.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentIds: selected, mode })
        }
      );
      updateConversation(conversation.id, data.conversation);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/30 px-4">
      <section className="w-full max-w-lg rounded-lg border border-slate-200 bg-white shadow-2xl">
        <header className="flex h-14 items-center justify-between border-b border-slate-200 px-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-950">管理会话 Agent</h2>
            <p className="text-xs text-slate-500">选择一个 Agent 为单聊，多个 Agent 自动转为群聊</p>
          </div>
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-md hover:bg-slate-100" title="关闭">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="max-h-[55vh] space-y-2 overflow-y-auto p-4">
          {Object.values(agents).map((agent) => (
            <label key={agent.id} className="flex cursor-pointer items-center gap-3 rounded-md border border-slate-200 px-3 py-2 hover:bg-slate-50">
              <input type="checkbox" checked={selected.includes(agent.id)} onChange={() => toggle(agent.id)} />
              <span className={`grid h-8 w-8 place-items-center rounded-full ${getAgentAvatarStyle(agent).solid}`}>{agent.avatar}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-900">{agent.name}</span>
                <span className="block truncate text-xs text-slate-500">{agent.description}</span>
              </span>
              {agent.isConductor ? <span className="rounded bg-amber-100 px-2 py-1 text-[10px] text-amber-700">Conductor</span> : null}
            </label>
          ))}
          {error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button type="button" onClick={onClose} disabled={saving} className="h-9 rounded-md px-3 text-sm text-slate-600 hover:bg-slate-100">取消</button>
          <button type="button" onClick={() => void save()} disabled={saving} className="flex h-9 items-center gap-2 rounded-md bg-blue-600 px-3 text-sm font-medium text-white disabled:opacity-60">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            保存
          </button>
        </footer>
      </section>
    </div>
  );
}
