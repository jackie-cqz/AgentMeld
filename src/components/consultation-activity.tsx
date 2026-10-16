"use client";

import { Check, ChevronDown, CircleHelp, Clock, Loader2, MessageSquare, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/stores/app-store";
import type { ConsultationStatus } from "@/shared/collaboration-types";

const LABELS: Record<ConsultationStatus, string> = {
  requested: "等待同事", running: "讨论中", replied: "已回复", declined: "已婉拒", cancelled: "已取消", expired: "已超时", failed: "咨询失败",
};

export function ConsultationActivity({ runId }: { runId: string }) {
  const consultations = useAppStore(useShallow(state => Object.values(state.consultations)
    .filter(item => item.sourceRunId === runId || item.targetRunId === runId).sort((a, b) => a.createdAt - b.createdAt)));
  const agents = useAppStore(state => state.agents);
  if (!consultations.length) return null;
  return <div className="mt-2 w-full min-w-0 border-t border-[var(--ui-border)] text-xs text-[var(--ui-muted)]" aria-label="团队咨询">
    {consultations.map(item => <details key={item.id} className="min-w-0 border-b border-[var(--ui-border)] py-2">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2">
        {item.status === "running" ? <Loader2 size={13} className="shrink-0 animate-spin" /> : item.status === "requested" ? <Clock size={13} className="shrink-0" /> : item.status === "replied" ? <Check size={13} className="shrink-0 text-emerald-600" /> : item.status === "declined" ? <CircleHelp size={13} className="shrink-0" /> : <X size={13} className="shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{agents[item.sourceAgentId]?.name ?? "Agent"} → {agents[item.targetAgentId]?.name ?? "Agent"}</span>
        <span className="shrink-0">{LABELS[item.status]}</span><ChevronDown size={12} className="shrink-0" />
      </summary>
      <div className="mt-2 min-w-0 space-y-2 break-words pl-5 leading-6">
        <p className="flex items-start gap-2"><MessageSquare size={13} className="mt-1 shrink-0" /><span className="min-w-0 whitespace-pre-wrap">{item.question}</span></p>
        {item.answer && item.sourceRunId === runId ? <p className="whitespace-pre-wrap text-[var(--foreground)]">{item.answer}</p> : null}
        {item.error ? <p role="status">{item.error}</p> : null}
      </div>
    </details>)}
  </div>;
}
