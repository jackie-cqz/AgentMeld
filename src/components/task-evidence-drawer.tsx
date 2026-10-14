"use client";

import { FileText, Terminal, Package, UserCheck, FolderOpen } from "lucide-react";
import type { ReactElement } from "react";
import { Modal } from "@/components/ui/modal";
import { Tabs } from "@/components/ui/controls";
import { CriterionVerdictList, type VerdictItem } from "@/components/criterion-verdict-list";
import { TaskContextManifest, type ManifestEntry } from "@/components/task-context-manifest";
import { TaskAttemptTimeline, type AttemptRecord } from "@/components/task-attempt-timeline";

export type DrawerTab = "context" | "evidence" | "verdicts" | "attempts";

export interface EvidenceSummary {
  id: string;
  type: string;
  status: string;
  trustLevel: string;
  subjectType: string;
  subjectId: string;
  payloadSummary?: Record<string, unknown> | null;
  contentHash?: string | null;
  createdAt: number;
}

function EvidenceTypeIcon({ type }: { type: string }): ReactElement {
  if (type.startsWith("file_")) return <FileText className="h-3.5 w-3.5 text-blue-500" />;
  if (type.startsWith("command_") || type.startsWith("test_")) return <Terminal className="h-3.5 w-3.5 text-amber-500" />;
  if (type.startsWith("artifact_")) return <Package className="h-3.5 w-3.5 text-purple-500" />;
  if (type.startsWith("deployment_")) return <FolderOpen className="h-3.5 w-3.5 text-emerald-500" />;
  if (type.startsWith("user_") || type.startsWith("approval_")) return <UserCheck className="h-3.5 w-3.5 text-green-500" />;
  return <FileText className="h-3.5 w-3.5 text-slate-400" />;
}

export function TaskEvidenceDrawer({
  open,
  onClose,
  taskId,
  activeTab,
  onTabChange,
  evidence,
  verdicts,
  verdictSummary,
  manifestIncluded,
  manifestOmitted,
  attempts,
}: {
  open: boolean;
  onClose: () => void;
  taskId: string;
  activeTab: DrawerTab;
  onTabChange: (tab: DrawerTab) => void;
  evidence?: EvidenceSummary[];
  verdicts?: VerdictItem[];
  verdictSummary?: { passed: number; failed: number; missing: number; needsReview: number; total: number };
  manifestIncluded?: ManifestEntry[];
  manifestOmitted?: ManifestEntry[];
  attempts?: AttemptRecord[];
}) {
  if (!open) return null;

  const tabs: { key: DrawerTab; label: string; count?: number }[] = [
    { key: "context", label: "上下文", count: (manifestIncluded?.length ?? 0) + (manifestOmitted?.length ?? 0) },
    { key: "evidence", label: "证据", count: evidence?.length },
    { key: "verdicts", label: "验收", count: verdicts?.length },
    { key: "attempts", label: "尝试", count: attempts?.length },
  ];

  return (
    <Modal open onClose={onClose} title="证据与验收详情" description={taskId} size="drawer"
      navigation={<Tabs label="任务详情" value={activeTab} onChange={onTabChange}
        items={tabs.map(tab => ({ value: tab.key, label: `${tab.label}${tab.count === undefined ? "" : ` (${tab.count})`}` }))} />}
      footer={<button className="ui-button" onClick={onClose}>完成</button>}>
      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "context" && manifestIncluded && manifestOmitted ? (
          <TaskContextManifest included={manifestIncluded} omitted={manifestOmitted} />
        ) : activeTab === "evidence" && evidence ? (
          <div className="space-y-1.5">
            {evidence.length === 0 ? (
              <p className="text-xs text-slate-400">暂无证据记录。</p>
            ) : (
              evidence.map((ev) => (
                <div key={ev.id} className="flex items-start gap-2 rounded border border-slate-100 bg-white px-2 py-1.5 text-xs">
                  <EvidenceTypeIcon type={ev.type} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] text-slate-400">{ev.type}</span>
                      <span className={`rounded px-1 py-0 text-[10px] font-medium ${
                        ev.status === "valid" ? "bg-emerald-100 text-emerald-700" :
                        ev.status === "invalid" ? "bg-red-100 text-red-700" :
                        "bg-slate-100 text-slate-600"
                      }`}>{ev.status}</span>
                      <span className="text-[10px] text-slate-400">{ev.trustLevel}</span>
                    </div>
                    <p className="mt-0.5 font-mono text-[11px] text-slate-600 truncate">
                      {ev.subjectType}:{ev.subjectId}
                    </p>
                    {ev.payloadSummary?.command ? (
                      <p className="mt-0.5 text-[10px] text-slate-500 truncate">
                        cmd: {ev.payloadSummary.command as string}
                        {ev.payloadSummary.exitCode !== null && ev.payloadSummary.exitCode !== undefined
                          ? ` (exit ${ev.payloadSummary.exitCode as number})` : ""}
                      </p>
                    ) : null}
                    {ev.contentHash ? (
                      <p className="text-[10px] font-mono text-slate-400">hash: {ev.contentHash.slice(0, 16)}...</p>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : activeTab === "verdicts" && verdicts ? (
          <CriterionVerdictList verdicts={verdicts} summary={verdictSummary} />
        ) : activeTab === "attempts" && attempts ? (
          <TaskAttemptTimeline attempts={attempts} />
        ) : (
          <p className="text-xs text-slate-400">暂无数据。</p>
        )}
      </div>
    </Modal>
  );
}
