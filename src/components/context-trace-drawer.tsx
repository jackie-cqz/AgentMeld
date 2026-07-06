"use client";

import { useEffect, useState } from "react";
import { X, Loader2, AlertTriangle, CheckCircle2, Eye, EyeOff, FileText, ShieldCheck, Link, Copy } from "lucide-react";
import type { ContextTraceResponse, ContextTraceWarning } from "@/server/context-trace/context-trace-types";

export function ContextTraceDrawer({
  attemptId,
  open,
  onClose,
}: {
  attemptId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<ContextTraceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"inputs" | "manifest" | "evidence" | "verdicts" | "warnings">("inputs");

  useEffect(() => {
    if (!open || !attemptId) return;
    setLoading(true);
    setError(null);
    fetch(`/api/context-trace/${attemptId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setError(d.error); setData(null); }
        else setData(d);
      })
      .catch(() => setError("Failed to load trace data"))
      .finally(() => setLoading(false));
  }, [open, attemptId]);

  if (!open) return null;

  const tabs = [
    { key: "inputs" as const, label: "上游输入", count: data?.upstreamInputs.length },
    { key: "manifest" as const, label: "上下文清单", count: (data?.includedManifest.length ?? 0) + (data?.omittedManifest.length ?? 0) },
    { key: "evidence" as const, label: "证据", count: data?.evidence.length },
    { key: "verdicts" as const, label: "验收", count: data?.verdicts.length },
    { key: "warnings" as const, label: "警告", count: data?.warnings.length },
  ];

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-[30rem] border-l border-slate-200 bg-white shadow-xl flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-slate-800 truncate">
            Context Trace
          </h3>
          {data && (
            <p className="text-[10px] text-slate-500 mt-0.5">
              {data.attempt.taskId} · {data.attempt.agentId} · attempt {data.attempt.attemptId?.slice(0, 12)}…
            </p>
          )}
        </div>
        <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Loading / Error / Content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center text-sm text-red-500 p-4 text-center">{error}</div>
      ) : data ? (
        <>
          {/* Status bar */}
          <div className="flex items-center gap-3 border-b px-4 py-2 text-[11px]">
            <StatusBadge label={data.attempt.executionStatus} kind="execution" />
            <StatusBadge label={data.attempt.verificationStatus} kind="verification" />
            {data.snapshot && (
              <span className="text-slate-400">{data.snapshot.tokenEstimate} tok</span>
            )}
          </div>

          {/* Tabs */}
          <div className="flex border-b">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex-1 px-2 py-1.5 text-[11px] font-medium border-b-2 transition-colors ${
                  tab === t.key ? "border-blue-500 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-700"
                }`}
              >
                {t.label}
                {t.count !== undefined && <span className="ml-0.5 text-slate-400">({t.count})</span>}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-3">
            {tab === "inputs" && <UpstreamInputsTab data={data} />}
            {tab === "manifest" && <ManifestTab data={data} />}
            {tab === "evidence" && <EvidenceTab data={data} />}
            {tab === "verdicts" && <VerdictsTab data={data} />}
            {tab === "warnings" && <WarningsTab data={data} />}
          </div>

          {/* Footer */}
          <div className="border-t px-4 py-2 text-[10px] text-slate-400 truncate">
            {data.attempt.contextSnapshotId
              ? `snapshot: ${data.attempt.contextSnapshotId}`
              : "no snapshot"}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── Tab content components ──────────────────────────────────────────────────

function UpstreamInputsTab({ data }: { data: ContextTraceResponse }) {
  if (data.upstreamInputs.length === 0) return <Empty text="无上游输入" />;
  return (
    <div className="space-y-1.5">
      {data.upstreamInputs.map((ui, i) => (
        <div key={i} className={`rounded border px-2.5 py-2 text-xs ${ui.bindingVerified ? "border-emerald-100 bg-emerald-50/30" : "border-red-100 bg-red-50/30"}`}>
          <div className="flex items-center gap-1.5">
            <Link className="h-3 w-3 text-slate-400" />
            <span className="font-medium">{ui.fromTaskId}.{ui.outputKey}</span>
            {ui.bindingVerified ? (
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
            ) : (
              <AlertTriangle className="h-3 w-3 text-red-500" />
            )}
          </div>
          {ui.bindingVerified && (
            <>
              <p className="mt-1 text-slate-600">{ui.artifactTitle} <span className="text-slate-400">({ui.artifactType} v{ui.artifactVersion})</span></p>
              <p className="mt-0.5 font-mono text-[10px] text-slate-400 cursor-pointer hover:text-blue-500" onClick={() => navigator.clipboard.writeText(ui.artifactId)}>
                <Copy className="inline h-2.5 w-2.5 mr-0.5" />{ui.artifactId}
              </p>
              <p className="mt-0.5 text-[10px]">
                {ui.readByCurrentAttempt
                  ? <span className="text-emerald-600">✓ read_artifact called</span>
                  : <span className="text-amber-600">⚠ not read</span>}
              </p>
            </>
          )}
          {!ui.bindingVerified && (
            <p className="mt-1 text-red-600">Output binding not found for this input</p>
          )}
        </div>
      ))}
    </div>
  );
}

function ManifestTab({ data }: { data: ContextTraceResponse }) {
  const all = [...data.includedManifest, ...data.omittedManifest];
  if (all.length === 0) return <Empty text="无上下文清单" />;
  return (
    <div className="space-y-3">
      {data.includedManifest.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-[11px] font-medium text-emerald-700 flex items-center gap-1"><Eye className="h-3 w-3" />已注入 ({data.includedManifest.length})</h4>
          <div className="space-y-1">
            {data.includedManifest.map((m, i) => (
              <ManifestRow key={`inc-${i}`} item={m} />
            ))}
          </div>
        </div>
      )}
      {data.omittedManifest.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-[11px] font-medium text-slate-500 flex items-center gap-1"><EyeOff className="h-3 w-3" />已省略 ({data.omittedManifest.length})</h4>
          <div className="space-y-1">
            {data.omittedManifest.map((m, i) => (
              <ManifestRow key={`omt-${i}`} item={m} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ManifestRow({ item: m }: { item: NonNullable<ContextTraceResponse>["includedManifest"][0] }) {
  return (
    <div className="flex items-start gap-1.5 rounded border border-slate-100 bg-white px-2 py-1 text-[11px]">
      {m.included ? <Eye className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" /> : <EyeOff className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-slate-400">{m.category}</span>
          <span className="font-mono text-slate-600 truncate max-w-[160px]">{m.sourceId}</span>
          <span className={`rounded px-1 py-0 text-[9px] ${trustColor(m.trustLevel)}`}>{m.trustLevel}</span>
        </div>
        <p className="text-slate-500">{m.included ? m.reason : `${m.omittedReason}: ${m.reason}`}</p>
      </div>
    </div>
  );
}

function EvidenceTab({ data }: { data: ContextTraceResponse }) {
  if (data.evidence.length === 0) return <Empty text="无证据记录" />;
  return (
    <div className="space-y-1">
      {data.evidence.map((ev) => (
        <div key={ev.evidenceId} className="flex items-start gap-2 rounded border border-slate-100 bg-white px-2 py-1.5 text-[11px]">
          <FileText className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-medium text-slate-700">{ev.type}</span>
              <span className={`rounded px-1 py-0 text-[9px] ${ev.status === "valid" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>{ev.status}</span>
              <span className="text-slate-400">{ev.trustLevel}</span>
            </div>
            <p className="mt-0.5 text-slate-500 truncate">{ev.excerpt}</p>
            <p className="font-mono text-[10px] text-slate-400 truncate">{ev.subjectType}:{ev.subjectId}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function VerdictsTab({ data }: { data: ContextTraceResponse }) {
  if (data.verdicts.length === 0) return <Empty text="无验收结果" />;
  return (
    <div className="space-y-1">
      {data.verdicts.map((v) => (
        <div key={v.id} className={`rounded border px-2 py-1.5 text-[11px] ${v.status === "passed" ? "border-emerald-100 bg-emerald-50/30" : v.status === "failed" ? "border-red-100 bg-red-50/30" : "border-amber-100 bg-amber-50/30"}`}>
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="h-3 w-3 text-slate-400" />
            <span className="font-medium">{v.criterionId}</span>
            <span className={`rounded px-1 py-0 text-[9px] font-medium ${v.status === "passed" ? "bg-emerald-100 text-emerald-700" : v.status === "failed" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>{v.status}</span>
          </div>
          <p className="mt-0.5 text-slate-600">{v.reason}</p>
          {v.evidenceIds.length > 0 && <p className="mt-0.5 text-slate-400">evidence: {v.evidenceIds.join(", ")}</p>}
        </div>
      ))}
    </div>
  );
}

function WarningsTab({ data }: { data: ContextTraceResponse }) {
  if (data.warnings.length === 0) return <Empty text="✓ 无警告" />;
  return (
    <div className="space-y-1">
      {data.warnings.map((w, i) => (
        <WarningRow key={i} w={w} />
      ))}
    </div>
  );
}

function WarningRow({ w }: { w: ContextTraceWarning }) {
  const icon = w.severity === "error" ? <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
    : w.severity === "warning" ? <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
    : null;
  return (
    <div className={`flex items-start gap-2 rounded border px-2 py-1.5 text-[11px] ${w.severity === "error" ? "border-red-100 bg-red-50/30" : w.severity === "warning" ? "border-amber-100 bg-amber-50/30" : "border-slate-100 bg-white"}`}>
      {icon}
      <div className="min-w-0">
        <span className="font-medium text-slate-600">{w.code}</span>
        <p className="text-slate-500">{w.message}</p>
      </div>
    </div>
  );
}

// ── Shared ──────────────────────────────────────────────────────────────────

function StatusBadge({ label, kind }: { label: string; kind: "execution" | "verification" }) {
  const success = kind === "execution" ? label === "reported_complete" : label === "verified";
  const fail = kind === "execution" ? label === "failed" : label === "rejected";
  const color = success ? "bg-emerald-100 text-emerald-700" : fail ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${color}`}>{label}</span>;
}

function Empty({ text }: { text: string }) {
  return <p className="text-xs text-slate-400 text-center py-8">{text}</p>;
}

function trustColor(level: string): string {
  const m: Record<string, string> = {
    authoritative: "bg-purple-100 text-purple-700",
    verified: "bg-emerald-100 text-emerald-700",
    accepted: "bg-blue-100 text-blue-700",
    reported: "bg-amber-100 text-amber-700",
    retrieved: "bg-slate-100 text-slate-600",
  };
  return m[level] ?? "bg-slate-100 text-slate-600";
}
