"use client";

import { Check, FileText, Loader2, X } from "lucide-react";
import { useState } from "react";
import { FileDiffView } from "@/components/file-diff-view";
import { requestJson } from "@/lib/request-json";
import { useAppStore } from "@/stores/app-store";

export function PendingWriteDiffTab({
  conversationId,
  pendingId
}: {
  conversationId: string;
  pendingId: string;
}) {
  const write = useAppStore((state) => state.pendingWrites[pendingId] ?? null);
  const closeTab = useAppStore((state) => state.closeConversationTab);
  const [resolving, setResolving] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!write) {
    return (
      <div className="grid h-full place-items-center bg-white p-6 text-center text-sm text-slate-500">
        <div>
          <p>这项文件写入审批已经处理或不存在。</p>
          <button type="button" onClick={() => closeTab(conversationId, `diff:${pendingId}`)} className="mt-3 rounded-md border border-slate-200 px-3 py-1.5">关闭标签</button>
        </div>
      </div>
    );
  }

  const resolve = async (approved: boolean) => {
    setResolving(approved ? "approve" : "reject");
    setError(null);
    try {
      await requestJson(`/api/pending-writes/${write.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved })
      });
      closeTab(conversationId, `diff:${pendingId}`);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "审批操作失败。");
    } finally {
      setResolving(null);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><FileText className="h-4 w-4 text-amber-600" />文件写入审批</div>
          <div className="mt-1 truncate font-mono text-xs text-slate-500" title={write.path}>{write.path}</div>
          <div className="mt-1 text-xs text-slate-400">Agent {write.agentId} · Run {write.runId}</div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" disabled={resolving !== null} onClick={() => void resolve(false)} className="flex h-9 items-center gap-2 rounded-md border border-red-200 px-3 text-sm text-red-700 disabled:opacity-60">
            {resolving === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}拒绝
          </button>
          <button type="button" disabled={resolving !== null} onClick={() => void resolve(true)} className="flex h-9 items-center gap-2 rounded-md bg-emerald-600 px-3 text-sm font-medium text-white disabled:opacity-60">
            {resolving === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}应用
          </button>
        </div>
      </header>
      {error ? <div className="shrink-0 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div> : null}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <FileDiffView oldContent={write.oldContent} newContent={write.newContent} />
      </div>
    </section>
  );
}
