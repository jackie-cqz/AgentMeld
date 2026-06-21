"use client";

import { X, File, MessageSquare } from "lucide-react";
import { useAppStore } from "@/stores/app-store";

export function ConversationTabBar({ conversationId }: { conversationId: string }) {
  const openFiles = useAppStore((s) => s.openFilesByConversation[conversationId] ?? []);
  const activeTab = useAppStore((s) => s.activeTabByConversation[conversationId] ?? "chat");
  const setActiveTab = useAppStore((s) => s.setActiveConversationTab);
  const closeFile = useAppStore((s) => s.closeConversationFile);

  if (openFiles.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5 border-b border-slate-200 bg-slate-50 px-2">
      {/* Chat tab */}
      <button
        onClick={() => setActiveTab(conversationId, "chat")}
        className={`flex items-center gap-1 border-b-2 px-3 py-1.5 text-xs transition ${
          activeTab === "chat" ? "border-[#4264ff] text-[#4264ff]" : "border-transparent text-slate-500 hover:text-slate-700"
        }`}
      >
        <MessageSquare className="h-3.5 w-3.5" /> 对话
      </button>

      {/* File tabs */}
      {openFiles.map((filePath) => {
        const fileName = filePath.split("/").pop() ?? filePath;
        const tabId = `file:${filePath}`;
        return (
          <button
            key={filePath}
            onClick={() => setActiveTab(conversationId, tabId)}
            className={`flex items-center gap-1 border-b-2 px-3 py-1.5 text-xs transition max-w-[160px] ${
              activeTab === tabId ? "border-[#4264ff] text-[#4264ff]" : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
            title={filePath}
          >
            <File className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{fileName}</span>
            <X
              className="ml-0.5 h-3 w-3 shrink-0 rounded-sm text-slate-400 hover:bg-slate-200 hover:text-slate-600"
              onClick={(e) => { e.stopPropagation(); closeFile(conversationId, filePath); }}
            />
          </button>
        );
      })}
    </div>
  );
}
