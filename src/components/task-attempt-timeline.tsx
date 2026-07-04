"use client";

import { CheckCircle2, XCircle, Loader2, Circle, RotateCcw } from "lucide-react";
import type { ReactElement } from "react";

export interface AttemptRecord {
  attemptId: string;
  attempt: number;
  childRunId: string | null;
  executionStatus: string;
  verificationStatus: string;
  contextTokenEstimate?: number;
  evidenceCount?: number;
  startedAt: number | null;
  finishedAt: number | null;
}

function AttemptIcon({ status }: { status: string }): ReactElement {
  switch (status) {
    case "verified":
    case "reported_complete":
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    case "rejected":
    case "failed":
      return <XCircle className="h-4 w-4 text-red-500" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
    case "queued":
      return <Circle className="h-4 w-4 text-slate-300" />;
    default:
      return <RotateCcw className="h-4 w-4 text-amber-500" />;
  }
}

export function TaskAttemptTimeline({ attempts }: { attempts: AttemptRecord[] }) {
  if (attempts.length === 0) {
    return <p className="text-xs text-slate-400">暂无尝试记录。</p>;
  }

  const sorted = [...attempts].sort((a, b) => a.attempt - b.attempt);

  return (
    <div className="space-y-2">
      {sorted.map((att, idx) => (
        <div key={att.attemptId} className="flex gap-3">
          {/* Timeline connector */}
          <div className="flex flex-col items-center">
            <AttemptIcon status={
              att.verificationStatus !== "not_started" ? att.verificationStatus : att.executionStatus
            } />
            {idx < sorted.length - 1 ? (
              <div className="mt-0.5 h-full w-0.5 bg-slate-200" />
            ) : null}
          </div>
          {/* Attempt card */}
          <div className={`flex-1 rounded border px-2.5 py-1.5 text-xs ${
            att.verificationStatus === "verified" ? "border-emerald-100 bg-emerald-50/30" :
            att.verificationStatus === "rejected" || att.executionStatus === "failed" ? "border-red-100 bg-red-50/30" :
            "border-slate-100 bg-white"
          }`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-700">第 {att.attempt} 次尝试</span>
              <span className={`text-[10px] px-1 py-0 rounded ${
                att.verificationStatus === "verified" ? "bg-emerald-100 text-emerald-700" :
                att.executionStatus === "failed" ? "bg-red-100 text-red-700" :
                "bg-slate-100 text-slate-600"
              }`}>
                {att.verificationStatus !== "not_started" ? att.verificationStatus : att.executionStatus}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
              {att.childRunId ? <span>Run: {att.childRunId}</span> : null}
              {att.contextTokenEstimate ? <span>上下文: {att.contextTokenEstimate} tok</span> : null}
              {att.evidenceCount ? <span>证据: {att.evidenceCount} 条</span> : null}
            </div>
            {att.startedAt && att.finishedAt ? (
              <span className="mt-0.5 block text-[10px] text-slate-400">
                耗时 {((att.finishedAt - att.startedAt) / 1000).toFixed(1)}s
              </span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
