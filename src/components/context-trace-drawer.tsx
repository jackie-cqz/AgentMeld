"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Tabs } from "@/components/ui/controls";
import { XCircle, Loader2, AlertTriangle, CheckCircle2, Eye, EyeOff, FileText, ShieldCheck, Link, Copy, ExternalLink } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
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
  const [requestError, setRequestError] = useState<{ attemptId: string; message: string } | null>(null);
  const [tab, setTab] = useState<"inputs" | "manifest" | "evidence" | "verdicts" | "warnings">("inputs");

  useEffect(() => {
    if (!open || !attemptId) return;
    const controller = new AbortController();
    fetch(`/api/context-trace/${attemptId}`)
      .then((r) => r.json())
      .then((d) => {
        if (controller.signal.aborted) return;
        if (d.error) {
          setRequestError({ attemptId, message: d.error });
          setData(null);
        } else {
          setRequestError(null);
          setData(d);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setRequestError({ attemptId, message: "Failed to load trace data" });
        }
      });
    return () => controller.abort();
  }, [open, attemptId]);

  const error = attemptId && requestError?.attemptId === attemptId ? requestError.message : null;
  const loading = Boolean(
    open &&
    attemptId &&
    data?.attempt.attemptId !== attemptId &&
    requestError?.attemptId !== attemptId
  );

  if (!open) return null;

  // P0: Diagnostic summary from trace data
  const diagnostic = buildDiagnostic(data, error);
  const hasNoAttempt = !attemptId;

  const tabs = [
    { key: "inputs" as const, label: "上游输入", count: data?.upstreamInputs.length },
    { key: "manifest" as const, label: "上下文清单", count: (data?.includedManifest.length ?? 0) + (data?.omittedManifest.length ?? 0) },
    { key: "evidence" as const, label: "证据", count: data?.evidence.length },
    { key: "verdicts" as const, label: "验收", count: data?.verdicts.length },
    { key: "warnings" as const, label: "警告", count: data?.warnings.length },
  ];

  return (
    <Modal open onClose={onClose} title="上下文追踪" description={attemptId ?? "未关联任务尝试"} size="drawer"
      navigation={<Tabs label="上下文追踪视图" value={tab} onChange={setTab} items={tabs.map(item => ({ value: item.key, label: item.label }))} />}
      footer={<button className="ui-button" onClick={onClose}>完成</button>}>
      {/* Loading / Error / No-attempt / Content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      ) : hasNoAttempt ? (
        <div className="flex-1 flex flex-col items-center justify-center p-4 text-center space-y-2">
          <AlertTriangle className="h-8 w-8 text-amber-400" />
          <p className="text-sm text-slate-600">无法打开上下文追踪</p>
          <p className="text-xs text-slate-400 max-w-xs">该消息没有关联的任务尝试记录。如果这是 Conductor 的聚合消息或历史消息，则无法追踪子 Agent 上下文。</p>
        </div>
      ) : error ? (
        <div className="flex-1 flex flex-col items-center justify-center p-4 text-center space-y-2">
          <XCircle className="h-8 w-8 text-red-400" />
          <p className="text-sm text-red-600">加载失败</p>
          <p className="text-xs text-slate-400">{error}</p>
        </div>
      ) : data ? (
        <>
          {/* P0: Diagnostic summary bar */}
          <div className="border-b px-4 py-2 space-y-1">
            <div className="flex items-center gap-3 text-[11px]">
              <StatusBadge label={data.attempt.executionStatus} kind="execution" />
              <StatusBadge label={data.attempt.verificationStatus} kind="verification" />
              {data.snapshot && (
                <span className="text-slate-400">{data.snapshot.tokenEstimate} tok</span>
              )}
            </div>
            {data.diagnostic ? (
              <p className={`text-[10px] font-medium ${data.diagnostic.severity === "error" ? "text-red-600" : data.diagnostic.severity === "warning" ? "text-amber-600" : "text-emerald-600"}`}>
                {data.diagnostic.label} — {data.diagnostic.detail}
              </p>
            ) : (
              <p className={`text-[10px] font-medium ${diagnostic.color}`}>{diagnostic.label}</p>
            )}
          </div>

          {/* Content */}
          <div className="p-3">
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
    </Modal>
  );
}

// ── Tab content components ──────────────────────────────────────────────────

function UpstreamInputsTab({ data }: { data: ContextTraceResponse }) {
  const setActiveArtifact = useAppStore((s) => s.setActiveArtifact);
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
              <div className="mt-0.5 flex items-center gap-1.5">
                <span
                  className="font-mono text-[10px] text-blue-500 cursor-pointer hover:text-blue-700 hover:underline flex items-center gap-0.5"
                  onClick={() => setActiveArtifact(ui.artifactId)}
                  title="在产物库中打开"
                >
                  <ExternalLink className="h-2.5 w-2.5" />{ui.artifactId}
                </span>
                <button
                  className="text-[10px] text-slate-400 hover:text-slate-600"
                  onClick={() => navigator.clipboard.writeText(ui.artifactId)}
                  title="复制 artifactId"
                >
                  <Copy className="h-2.5 w-2.5" />
                </button>
              </div>
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

// P0: Chinese warning code labels
const WARNING_LABELS: Record<string, string> = {
  missing_context_snapshot: "缺少上下文快照",
  missing_required_upstream_input: "缺少必需上游输入",
  unread_verified_input: "上游产物已验证，但当前 Agent 没有读取",
  guessed_artifact_id: "疑似虚构产物 ID",
  unverified_output_not_propagated: "产物未通过验证，未传播到下游",
  output_binding_missing: "产物已创建但未绑定输出",
  context_budget_omitted_high_priority: "上下文预算不足，高优先级项被省略",
  tool_claim_without_evidence: "声称完成但缺少工具证据",
};

function WarningRow({ w }: { w: ContextTraceWarning }) {
  const icon = w.severity === "error" ? <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
    : w.severity === "warning" ? <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
    : null;
  const label = WARNING_LABELS[w.code] ?? w.code;
  return (
    <div className={`flex items-start gap-2 rounded border px-2 py-1.5 text-[11px] ${w.severity === "error" ? "border-red-100 bg-red-50/30" : w.severity === "warning" ? "border-amber-100 bg-amber-50/30" : "border-slate-100 bg-white"}`}>
      {icon}
      <div className="min-w-0">
        <span className="font-medium text-slate-600">{label}</span>
        <p className="text-slate-500">{w.message}</p>
      </div>
    </div>
  );
}

// ── P0: Diagnostic summary builder ──────────────────────────────────────────

function buildDiagnostic(
  data: import("@/server/context-trace/context-trace-types").ContextTraceResponse | null,
  error: string | null
): { label: string; color: string } {
  if (!data) {
    if (error) return { label: `加载失败：${error}`, color: "text-red-600" };
    return { label: "正在加载…", color: "text-slate-400" };
  }

  const missingInputs = data.upstreamInputs.filter((u) => !u.bindingVerified).length;
  const unreadVerified = data.upstreamInputs.filter((u) => u.bindingVerified && !u.readByCurrentAttempt).length;
  const hasArtifactEvidence = data.evidence.some((e) => e.type === "artifact_created");
  const hasOutputBindings = data.outputBindings.length > 0;
  const failedVerdicts = data.verdicts.filter((v) => v.status === "failed").length;

  if (missingInputs > 0) {
    return { label: `⚠ 缺上游输入：${missingInputs} 个必需输入没有 output binding`, color: "text-red-600" };
  }
  if (unreadVerified > 0) {
    return { label: `⚠ 未读取产物：${unreadVerified} 个已验证的上游产物未被 read_artifact`, color: "text-amber-600" };
  }
  if (hasArtifactEvidence && !hasOutputBindings) {
    return { label: `⚠ 输出绑定失败：产物已创建但未成功绑定`, color: "text-amber-600" };
  }
  if (failedVerdicts > 0) {
    return { label: `⚠ 验收未通过：${failedVerdicts} 条标准失败`, color: "text-red-600" };
  }
  if (data.evidence.length < 2 && data.attempt.executionStatus === "reported_complete") {
    return { label: `⚠ 工具证据不足：仅 ${data.evidence.length} 条证据记录`, color: "text-amber-600" };
  }
  if (data.warnings.length === 0) {
    return { label: "✓ 正常 — 上下文链路完整", color: "text-emerald-600" };
  }
  return { label: `检查完毕 — ${data.warnings.length} 条警告`, color: "text-amber-600" };
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
