"use client";

import { X, File, FileDiff, MessageSquare } from "lucide-react";
import { useAppStore } from "@/stores/app-store";

const EMPTY_TABS: string[] = [];

export function ConversationTabBar({ conversationId }: { conversationId: string }) {
  const openFiles = useAppStore((s) => s.openFilesByConversation[conversationId] ?? EMPTY_TABS);
  const openDiffs = useAppStore((s) => s.openDiffsByConversation[conversationId] ?? EMPTY_TABS);
  const pendingWrites = useAppStore((s) => s.pendingWrites);
  const activeTab = useAppStore((s) => s.activeTabByConversation[conversationId] ?? "chat");
  const setActiveTab = useAppStore((s) => s.setActiveConversationTab);
  const closeTab = useAppStore((s) => s.closeConversationTab);

  if (openFiles.length === 0 && openDiffs.length === 0) return null;

  return (
    <div className="flex min-h-10 items-end gap-0.5 overflow-x-auto border-b border-slate-200 bg-slate-50 px-2">
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
              onClick={(e) => { e.stopPropagation(); closeTab(conversationId, tabId); }}
            />
          </button>
        );
      })}
      {openDiffs.map((pendingId) => {
        const tabId = `diff:${pendingId}`;
        const write = pendingWrites[pendingId];
        return (
          <button
            key={pendingId}
            type="button"
            onClick={() => setActiveTab(conversationId, tabId)}
            className={`flex max-w-[190px] shrink-0 items-center gap-1 border-b-2 px-3 py-1.5 text-xs transition ${
              activeTab === tabId ? "border-amber-500 text-amber-700" : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
            title={write?.path ?? pendingId}
          >
            <FileDiff className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Diff: {write?.path.split("/").pop() ?? pendingId}</span>
            <X className="ml-0.5 h-3 w-3 shrink-0 rounded-sm text-slate-400 hover:bg-slate-200" onClick={(event) => { event.stopPropagation(); closeTab(conversationId, tabId); }} />
          </button>
        );
      })}
    </div>
  );
}
