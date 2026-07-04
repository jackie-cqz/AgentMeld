"use client";

import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import type { EvidenceTrustLevel } from "@/shared/evidence-types";

export interface ManifestEntry {
  category: string;
  sourceType: string;
  sourceId: string;
  reason: string;
  trustLevel: EvidenceTrustLevel;
  tokenEstimate: number;
  included: boolean;
  omittedReason?: string | null;
}

function TrustBadge({ level }: { level: EvidenceTrustLevel }) {
  const styles: Record<string, string> = {
    authoritative: "bg-purple-100 text-purple-700",
    verified: "bg-emerald-100 text-emerald-700",
    accepted: "bg-blue-100 text-blue-700",
    reported: "bg-amber-100 text-amber-700",
    retrieved: "bg-slate-100 text-slate-600",
  };
  return (
    <span className={`rounded px-1 py-0 text-[10px] font-medium ${styles[level] ?? "bg-slate-100 text-slate-600"}`}>
      {level}
    </span>
  );
}

export function TaskContextManifest({
  included,
  omitted,
}: {
  included: ManifestEntry[];
  omitted: ManifestEntry[];
}) {
  const includedTokens = included.reduce((s, m) => s + m.tokenEstimate, 0);
  const omittedTokens = omitted.reduce((s, m) => s + m.tokenEstimate, 0);

  return (
    <div className="space-y-3">
      {/* Summary bar */}
      <div className="flex items-center gap-3 text-xs">
        <span className="flex items-center gap-1 text-emerald-600">
          <Eye className="h-3.5 w-3.5" />
          已注入 {included.length} 项 · {includedTokens > 1000 ? `${(includedTokens / 1000).toFixed(1)}k` : includedTokens} tok
        </span>
        {omitted.length > 0 ? (
          <span className="flex items-center gap-1 text-slate-500">
            <EyeOff className="h-3.5 w-3.5" />
            已省略 {omitted.length} 项 · {omittedTokens > 1000 ? `${(omittedTokens / 1000).toFixed(1)}k` : omittedTokens} tok
          </span>
        ) : null}
      </div>

      {/* Included items */}
      {included.length > 0 ? (
        <div>
          <h4 className="mb-1.5 text-[11px] font-medium text-slate-700">已注入上下文</h4>
          <div className="space-y-1">
            {included.map((m, i) => (
              <ManifestRow key={`inc-${m.sourceId}-${i}`} entry={m} />
            ))}
          </div>
        </div>
      ) : null}

      {/* Omitted items */}
      {omitted.length > 0 ? (
        <div>
          <h4 className="mb-1.5 text-[11px] font-medium text-slate-500">已省略</h4>
          <div className="space-y-1">
            {omitted.map((m, i) => (
              <ManifestRow key={`omt-${m.sourceId}-${i}`} entry={m} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ManifestRow({ entry: m }: { entry: ManifestEntry }) {
  return (
    <div className={`flex items-start gap-2 rounded border px-2 py-1 text-xs ${
      m.included ? "border-emerald-100 bg-white" : "border-slate-100 bg-slate-50/50"
    }`}>
      {m.included ? (
        <Eye className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
      ) : (
        <EyeOff className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-slate-400">{m.category}</span>
          <span className="font-mono text-[11px] text-slate-600 truncate max-w-[180px]">{m.sourceId}</span>
          <TrustBadge level={m.trustLevel} />
        </div>
        <p className="mt-0.5 text-[11px] text-slate-500">
          {m.included ? m.reason : (m.omittedReason ? `${m.omittedReason}: ${m.reason}` : m.reason)}
        </p>
        <span className="text-[10px] text-slate-400">~{m.tokenEstimate} tok · {m.sourceType}</span>
      </div>
    </div>
  );
}
