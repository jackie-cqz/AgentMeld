"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { requestJson } from "@/lib/request-json";
import { getAgentAvatarStyle } from "@/shared/agent-avatar";
import { useAppStore } from "@/stores/app-store";
import type { Conversation } from "@/shared/types";
import { Modal, useUnsavedChanges } from "@/components/ui/modal";
import { Feedback } from "@/components/ui/controls";

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
  const discard = useUnsavedChanges(selected.length !== conversation.agentIds.length || selected.some(id => !conversation.agentIds.includes(id)), onClose, saving);

  if (!open) return null;

  const toggle = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((agentId) => agentId !== id) : [...current, id]
    );
  };

  const save = async () => {
    if (saving) return;
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
    <><Modal open={open} onClose={discard.requestClose} title="管理会话 Agent" description={`${selected.length} 位成员 · ${conversation.title}`} busy={saving}
      footer={<>{error ? <Feedback>{error}</Feedback> : null}<button className="ui-button ui-button--quiet" onClick={discard.requestClose} disabled={saving}>取消</button>
        <button className="ui-button ui-button--primary" onClick={() => void save()} disabled={saving}>{saving ? <Loader2 size={15} className="animate-spin" /> : null}保存成员</button></>}>
        <div className="ui-form">
          {Object.values(agents).map((agent) => (
            <label key={agent.id} className="ui-list-row cursor-pointer">
              <input type="checkbox" checked={selected.includes(agent.id)} onChange={() => toggle(agent.id)} />
              <span className={`grid h-8 w-8 place-items-center rounded-full ${getAgentAvatarStyle(agent).solid}`}>{agent.avatar}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-900">{agent.name}</span>
                <span className="block truncate text-xs text-slate-500">{agent.description}</span>
              </span>
              {agent.isConductor ? <span className="rounded bg-amber-100 px-2 py-1 text-[10px] text-amber-700">Conductor</span> : null}
            </label>
          ))}
        </div>
    </Modal>{discard.confirmation}</>
  );
}
