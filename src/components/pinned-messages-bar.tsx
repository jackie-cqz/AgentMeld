"use client";

import { ChevronDown, ChevronUp, Pin, X } from "lucide-react";
import { useState } from "react";
import { requestJson } from "@/lib/request-json";
import { useAppStore } from "@/stores/app-store";
import type { Conversation } from "@/shared/types";

export function PinnedMessagesBar({ conversation }: { conversation: Conversation }) {
  const messages = useAppStore((state) => state.messages);
  const updateConversation = useAppStore((state) => state.updateConversation);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pinned = conversation.pinnedMessageIds
    .map((id) => messages[id])
    .filter((message) => message !== undefined);

  if (pinned.length === 0) return null;

  const unpin = async (messageId: string) => {
    setError(null);
    try {
      const data = await requestJson<{ pinnedMessageIds: string[] }>(`/api/messages/${messageId}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: false })
      });
      updateConversation(conversation.id, { pinnedMessageIds: data.pinnedMessageIds });
    } catch (unpinError) {
      setError(unpinError instanceof Error ? unpinError.message : "取消置顶失败。");
    }
  };

  return (
    <div className="mx-auto mb-4 max-w-[760px] rounded-md border border-amber-200 bg-amber-50">
      <button type="button" onClick={() => setExpanded((value) => !value)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-amber-900">
        <Pin className="h-3.5 w-3.5" />
        {pinned.length} 条置顶消息
        {expanded ? <ChevronUp className="ml-auto h-3.5 w-3.5" /> : <ChevronDown className="ml-auto h-3.5 w-3.5" />}
      </button>
      {expanded ? (
        <div className="space-y-1 border-t border-amber-200 p-2">
          {pinned.map((message) => (
            <div key={message.id} className="flex items-center gap-2 rounded bg-white px-2 py-1.5 text-xs text-slate-700">
              <button
                type="button"
                onClick={() => document.getElementById(`message-${message.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
                className="min-w-0 flex-1 truncate text-left"
              >
                {messageSummary(message.parts)}
              </button>
              <button type="button" onClick={() => void unpin(message.id)} className="grid h-6 w-6 place-items-center rounded hover:bg-red-50 hover:text-red-600" title="取消置顶">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {error ? <p className="px-2 py-1 text-xs text-red-600">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function messageSummary(parts: import("@/shared/types").MessagePart[]) {
  const text = parts.find((part) => part.type === "text");
  return text?.type === "text" ? text.content.slice(0, 140) : "附件或结构化消息";
}
