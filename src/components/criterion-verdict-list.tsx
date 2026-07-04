"use client";

import { CheckCircle2, XCircle, AlertTriangle, Eye, HelpCircle } from "lucide-react";
import type { ReactElement } from "react";

export interface VerdictItem {
  id: string;
  criterionId: string;
  validatorType: string;
  status: "passed" | "failed" | "missing" | "needs_review";
  evidenceIds: string[];
  reason: string;
  checkedAt: number;
}

function VerdictStatusIcon({ status }: { status: VerdictItem["status"] }): ReactElement {
  switch (status) {
    case "passed": return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
    case "failed": return <XCircle className="h-3.5 w-3.5 text-red-500" />;
    case "missing": return <HelpCircle className="h-3.5 w-3.5 text-slate-400" />;
    case "needs_review": return <Eye className="h-3.5 w-3.5 text-amber-500" />;
  }
}

function VerdictStatusLabel({ status }: { status: VerdictItem["status"] }): string {
  switch (status) {
    case "passed": return "通过";
    case "failed": return "失败";
    case "missing": return "缺失";
    case "needs_review": return "待审查";
  }
}

export function CriterionVerdictList({
  verdicts,
  summary,
}: {
  verdicts: VerdictItem[];
  summary?: { passed: number; failed: number; missing: number; needsReview: number; total: number };
}) {
  if (verdicts.length === 0) {
    return <p className="text-xs text-slate-400">暂无验收结果。</p>;
  }

  return (
    <div className="space-y-1.5">
      {summary ? (
        <div className="mb-2 flex flex-wrap gap-2 text-[10px]">
          <span className="flex items-center gap-0.5 text-emerald-600">
            <CheckCircle2 className="h-3 w-3" />通过 {summary.passed}
          </span>
          <span className="flex items-center gap-0.5 text-red-600">
            <XCircle className="h-3 w-3" />失败 {summary.failed}
          </span>
          <span className="flex items-center gap-0.5 text-slate-500">
            <HelpCircle className="h-3 w-3" />缺失 {summary.missing}
          </span>
          <span className="flex items-center gap-0.5 text-amber-600">
            <Eye className="h-3 w-3" />待审 {summary.needsReview}
          </span>
        </div>
      ) : null}
      {verdicts.map((v) => (
        <div
          key={v.id}
          className={`flex items-start gap-2 rounded border px-2 py-1.5 text-xs ${
            v.status === "failed" ? "border-red-100 bg-red-50/50" :
            v.status === "passed" ? "border-emerald-100 bg-emerald-50/30" :
            "border-slate-100 bg-slate-50"
          }`}
        >
          <VerdictStatusIcon status={v.status} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-slate-700">{v.criterionId}</span>
              <span className="text-[10px] text-slate-400">({v.validatorType})</span>
              <span className="text-[10px] font-medium text-slate-500">
                <VerdictStatusLabel status={v.status} />
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-slate-600">{v.reason}</p>
            {v.evidenceIds.length > 0 ? (
              <div className="mt-0.5 flex flex-wrap gap-1">
                {v.evidenceIds.map((eid) => (
                  <span key={eid} className="rounded bg-slate-100 px-1 py-0 text-[10px] font-mono text-slate-500">
                    {eid}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
