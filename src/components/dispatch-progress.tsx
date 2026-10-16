"use client";

import {
  Ban, CheckCircle2, Circle, Clock3, GitBranch,
  Loader2, RotateCcw, XCircle, AlertTriangle, RefreshCw,
  FileCheck, ShieldCheck, Eye, ChevronDown, ChevronRight
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import type { DispatchState } from "@/stores/store-types";
import type { ReactElement } from "react";
import { useState, useCallback } from "react";
import { TaskEvidenceDrawer, type DrawerTab } from "@/components/task-evidence-drawer";
import type { EvidenceSummary } from "@/components/task-evidence-drawer";
import type { VerdictItem } from "@/components/criterion-verdict-list";
import type { ManifestEntry } from "@/components/task-context-manifest";
import type { AttemptRecord } from "@/components/task-attempt-timeline";
import { ContextTraceDrawer } from "@/components/context-trace-drawer";
import { TaskHandoffControl } from "@/components/task-handoff-control";

export function DispatchProgress({ messageId }: { messageId: string }) {
  const dispatch = useAppStore((state) =>
    Object.values(state.dispatchesByRunId).find((item) => item.messageId === messageId) ?? null
  );

  // P7: Evidence drawer state + API-fetched data
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTaskId, setDrawerTaskId] = useState("");
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("context");
  // P1: Context Trace drawer
  const [traceDrawerOpen, setTraceDrawerOpen] = useState(false);
  const [traceAttemptId, setTraceAttemptId] = useState<string | null>(null);
  const [drawerEvidence, setDrawerEvidence] = useState<EvidenceSummary[]>([]);
  const [drawerVerdicts, setDrawerVerdicts] = useState<VerdictItem[]>([]);
  const [drawerVerdictSummary, setDrawerVerdictSummary] = useState<{ passed: number; failed: number; missing: number; needsReview: number; total: number }>({ passed: 0, failed: 0, missing: 0, needsReview: 0, total: 0 });
  const [drawerManifestIncluded, setDrawerManifestIncluded] = useState<ManifestEntry[]>([]);
  const [drawerManifestOmitted, setDrawerManifestOmitted] = useState<ManifestEntry[]>([]);
  const [drawerAttempts, setDrawerAttempts] = useState<AttemptRecord[]>([]);

  // P7: Fetch real data from API when drawer opens
  const fetchDrawerData = useCallback(async (taskId: string) => {
    const activeAttemptId = dispatch?.activeAttemptByTask[taskId];
    if (!activeAttemptId) return;

    try {
      // Fetch evidence
      const evRes = await fetch(`/api/task-attempts/${activeAttemptId}/evidence`);
      if (evRes.ok) {
        const evData = await evRes.json();
        setDrawerEvidence(evData.evidence ?? []);
      }

      // Fetch verdicts
      const vRes = await fetch(`/api/task-attempts/${activeAttemptId}/verdicts`);
      if (vRes.ok) {
        const vData = await vRes.json();
        setDrawerVerdicts(vData.verdicts ?? []);
        setDrawerVerdictSummary(vData.summary ?? { passed: 0, failed: 0, missing: 0, needsReview: 0, total: 0 });
      }

      // Fetch context manifest
      const cRes = await fetch(`/api/task-attempts/${activeAttemptId}/context`);
      if (cRes.ok) {
        const cData = await cRes.json();
        setDrawerManifestIncluded(cData.manifest?.included ?? []);
        setDrawerManifestOmitted(cData.manifest?.omitted ?? []);
      }

      // Fetch attempt detail — use real API data for execution status + timestamps
      const aRes = await fetch(`/api/task-attempts/${activeAttemptId}`);
      if (aRes.ok) {
        const aData = await aRes.json();
        // Merge API data (executionStatus, startedAt, finishedAt) with store
        // data (verification, context, evidence summaries).
        const apiAttempt = aData.attempt;
        const storeAttemptIds = dispatch?.attemptIdsByTask[taskId] ?? [activeAttemptId];
        const attempts: AttemptRecord[] = storeAttemptIds.map((aid, idx) => {
          // For the active attempt, use API data; for others, use store summary
          const isActive = aid === activeAttemptId;
          return {
            attemptId: aid,
            attempt: idx + 1,
            childRunId: isActive ? (apiAttempt?.childRunId ?? dispatch?.childRunIds[taskId] ?? null) : (dispatch?.childRunIds[taskId] ?? null),
            executionStatus: isActive ? (apiAttempt?.executionStatus ?? "complete") : "complete",
            verificationStatus: dispatch?.verificationStatusByTask[taskId] ?? "not_started",
            contextTokenEstimate: dispatch?.contextSummaryByAttempt[aid]?.tokenEstimate,
            evidenceCount: dispatch?.evidenceCountByAttempt[aid] ?? 0,
            startedAt: isActive ? (apiAttempt?.startedAt ?? null) : null,
            finishedAt: isActive ? (apiAttempt?.finishedAt ?? null) : null,
          };
        });
        setDrawerAttempts(attempts);
      }
    } catch {
      // API not available — drawer shows empty state
    }
  }, [dispatch]);

  if (!dispatch || dispatch.plan.length === 0) return null;

  const total = dispatch.plan.length;
  const complete = Object.values(dispatch.taskStatus).filter((s) => s === "complete").length;
  const failed = Object.values(dispatch.taskStatus).filter((s) => s === "failed" || s === "aborted" || s === "blocked").length;
  const skipped = Object.values(dispatch.taskStatus).filter((s) => s === "skipped").length;
  const running = Object.values(dispatch.taskStatus).filter((s) => s === "running").length;

  // Determine aggregate status
  let aggStatus: { label: string; color: string; icon: ReactElement } = { label: "执行中", color: "text-blue-700", icon: <Loader2 className="h-4 w-4 animate-spin text-blue-600" /> };
  const terminal = complete + failed + skipped;
  if (failed > 0) aggStatus = { label: terminal === total ? "执行结束，存在失败" : "部分失败", color: "text-red-700", icon: <AlertTriangle className="h-4 w-4 text-red-600" /> };
  else if (terminal === total && skipped > 0) aggStatus = { label: "部分完成", color: "text-amber-700", icon: <AlertTriangle className="h-4 w-4 text-amber-600" /> };
  else if (complete === total) aggStatus = { label: "全部完成", color: "text-emerald-700", icon: <CheckCircle2 className="h-4 w-4 text-emerald-600" /> };

  const handleOpenDrawer = (taskId: string, tab: DrawerTab) => {
    setDrawerTaskId(taskId);
    setDrawerTab(tab);
    setDrawerOpen(true);
    void fetchDrawerData(taskId);
  };

  const handleOpenTrace = (taskId: string) => {
    const attemptId = dispatch?.activeAttemptByTask[taskId];
    if (attemptId) {
      setTraceAttemptId(attemptId);
      setTraceDrawerOpen(true);
    }
  };

  return (
    <>
      <section className="mt-3 border-y border-[var(--ui-border)] py-3">
        <header className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex shrink-0 items-center gap-2 text-sm font-medium text-[var(--ui-text)]">
            <GitBranch className="h-4 w-4 text-blue-600" />
            调度进度
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-2">
            <span className={`flex items-center gap-1 text-xs font-medium ${aggStatus.color}`}>
              {aggStatus.icon}{aggStatus.label}
            </span>
            <span className="text-xs text-slate-500">
              完成 {complete}/{total} · 失败 {failed} · 跳过 {skipped}
              {running > 0 ? ` · 运行中 ${running}` : ""}
            </span>
          </div>
        </header>
        <div className="mt-3 space-y-2">
          {dispatch.plan.map((task) => (
            <DispatchTaskRow key={task.id} dispatch={dispatch} taskId={task.id} onOpenDrawer={handleOpenDrawer} onOpenTrace={handleOpenTrace} />
          ))}
        </div>
      </section>

      {/* P7: Evidence drawer — slides in from the right, with API-fetched data */}
      <TaskEvidenceDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        taskId={drawerTaskId}
        activeTab={drawerTab}
        onTabChange={setDrawerTab}
        evidence={drawerEvidence}
        verdicts={drawerVerdicts}
        verdictSummary={drawerVerdictSummary}
        manifestIncluded={drawerManifestIncluded}
        manifestOmitted={drawerManifestOmitted}
        attempts={drawerAttempts}
      />

      {/* P1: Context Trace drawer — full API-driven diagnostic view */}
      <ContextTraceDrawer
        attemptId={traceAttemptId}
        open={traceDrawerOpen}
        onClose={() => setTraceDrawerOpen(false)}
      />
    </>
  );
}

function DispatchTaskRow({ dispatch, taskId, onOpenDrawer, onOpenTrace }: { dispatch: DispatchState; taskId: string; onOpenDrawer: (taskId: string, tab: DrawerTab) => void; onOpenTrace?: (taskId: string) => void }) {
  const agents = useAppStore((state) => state.agents);
  const task = dispatch.plan.find((item) => item.id === taskId);
  const [expanded, setExpanded] = useState(false);
  if (!task) return null;
  const status = dispatch.taskStatus[taskId] ?? "pending";
  const agent = agents[task.agentId];
  const attemptCount = dispatch.attempts[taskId] ?? 1;
  const activeAttemptId = dispatch.activeAttemptByTask[taskId];
  const verificationStatus = dispatch.verificationStatusByTask[taskId];
  const evidenceCount = activeAttemptId ? (dispatch.evidenceCountByAttempt[activeAttemptId] ?? 0) : 0;
  const contextSummary = activeAttemptId ? dispatch.contextSummaryByAttempt[activeAttemptId] : undefined;
  const verdictSummary = activeAttemptId ? dispatch.verdictSummaryByAttempt[activeAttemptId] : undefined;

  return (
    <div className={`rounded-md border px-3 py-2 ${
      status === "failed" || status === "aborted" ? "border-red-100 bg-red-50/50" :
      status === "complete" ? "border-emerald-100 bg-white" :
      status === "running" ? "border-blue-200 bg-white" :
      "border-blue-100 bg-white"
    }`}>
      <div className="flex items-start gap-2">
        <StatusIcon status={status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-slate-400">{task.id}</span>
            <span className="text-xs font-medium text-slate-800">{agent?.name ?? task.agentId}</span>
            <StatusLabel status={status} />
            {attemptCount > 1 ? (
              <span className="flex items-center gap-0.5 text-[10px] text-amber-600">
                <RefreshCw className="h-3 w-3" />第{attemptCount}次
              </span>
            ) : status === "running" ? (
              <span className="flex items-center gap-0.5 text-[10px] text-blue-600">
                <RefreshCw className="h-3 w-3" />第1次
              </span>
            ) : null}
            {/* P7: Verification status badge */}
            {verificationStatus ? (
              <VerificationBadge status={verificationStatus} />
            ) : null}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">{task.task}</p>
          {task.dependsOn.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {task.dependsOn.map((dep) => (
                <span key={dep} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">依赖 {dep}</span>
              ))}
            </div>
          ) : null}
          <div className="mt-1 flex flex-wrap gap-1">
            {task.acceptanceCriteria?.map((criterion, idx) => (
              <span key={idx} className="rounded bg-purple-50 px-1.5 py-0.5 text-[10px] text-purple-700">验收: {criterion}</span>
            ))}
            {task.expectedOutputs?.map((output) => (
              <span key={output.id} className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">{output.id} · {output.type}</span>
            ))}
            {task.targetPaths?.map((path) => (
              <span key={path} className="rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700">{path}</span>
            ))}
          </div>
          {/* P7: Evidence-aware summary row — clickable items open the drawer */}
          {(evidenceCount > 0 || contextSummary || verdictSummary) ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-1.5">
              {contextSummary ? (
                <button
                  onClick={() => onOpenDrawer(taskId, "context")}
                  className="flex items-center gap-0.5 text-[10px] text-blue-600 hover:text-blue-800 hover:underline"
                  title={`${contextSummary.includedCount} included, ${contextSummary.omittedCount} omitted`}
                >
                  <Eye className="h-3 w-3" />上下文 {contextSummary.includedCount}项 · {contextSummary.tokenEstimate > 1000 ? `${(contextSummary.tokenEstimate / 1000).toFixed(1)}k` : contextSummary.tokenEstimate} tok
                </button>
              ) : null}
              {evidenceCount > 0 ? (
                <button
                  onClick={() => onOpenDrawer(taskId, "evidence")}
                  className="flex items-center gap-0.5 text-[10px] text-blue-600 hover:text-blue-800 hover:underline"
                >
                  <FileCheck className="h-3 w-3" />证据 {evidenceCount}项
                </button>
              ) : null}
              {verdictSummary ? (
                <button
                  onClick={() => onOpenDrawer(taskId, "verdicts")}
                  className={`flex items-center gap-0.5 text-[10px] hover:underline ${verdictSummary.failed > 0 ? "text-red-600 hover:text-red-800" : "text-blue-600 hover:text-blue-800"}`}
                >
                  <ShieldCheck className="h-3 w-3" />验收 {verdictSummary.passed}/{verdictSummary.passed + verdictSummary.failed + verdictSummary.missing + verdictSummary.needsReview}
                </button>
              ) : null}
              {(dispatch.attempts[taskId] ?? 1) > 1 ? (
                <button
                  onClick={() => onOpenDrawer(taskId, "attempts")}
                  className="flex items-center gap-0.5 text-[10px] text-blue-600 hover:text-blue-800 hover:underline"
                >
                  第{dispatch.attempts[taskId]}次尝试
                </button>
              ) : null}
              {/* P1: Trace button — opens full context trace drawer */}
              {onOpenTrace ? (
                <button
                  onClick={() => onOpenTrace(taskId)}
                  className="flex items-center gap-0.5 text-[10px] text-violet-600 hover:text-violet-800 hover:underline"
                  title="查看完整上下文链路"
                >
                  Trace
                </button>
              ) : null}
              {/* Expand inline summary */}
              <button
                onClick={() => setExpanded(!expanded)}
                className="ml-auto flex items-center gap-0.5 text-[10px] text-slate-400 hover:text-slate-600"
              >
                {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {expanded ? "收起" : "摘要"}
              </button>
            </div>
          ) : null}
          {/* P7: Expanded detail panel */}
          {expanded ? (
            <div className="mt-2 space-y-2 border-t border-slate-100 pt-2">
              <AttemptDetailPanel dispatch={dispatch} taskId={taskId} />
            </div>
          ) : null}
          {dispatch.errors[taskId] ? (
            <p className="mt-1 text-xs text-red-600">{dispatch.errors[taskId]}</p>
          ) : null}
          <TaskHandoffControl runId={dispatch.runId} taskId={taskId} attemptId={activeAttemptId} sourceAgentId={task.agentId} verified={verificationStatus === "verified"} />
        </div>
      </div>
    </div>
  );
}

/** P7: Inline detail panel showing attempt-level evidence/verdict summary */
function AttemptDetailPanel({ dispatch, taskId }: { dispatch: DispatchState; taskId: string }) {
  const activeAttemptId = dispatch.activeAttemptByTask[taskId];
  const verdictSummary = activeAttemptId ? dispatch.verdictSummaryByAttempt[activeAttemptId] : undefined;
  const contextSummary = activeAttemptId ? dispatch.contextSummaryByAttempt[activeAttemptId] : undefined;
  const evidenceCount = activeAttemptId ? (dispatch.evidenceCountByAttempt[activeAttemptId] ?? 0) : 0;
  const verificationStatus = dispatch.verificationStatusByTask[taskId];

  return (
    <div className="rounded bg-slate-50 p-2 text-[11px] text-slate-600 space-y-1">
      <div className="font-medium text-slate-700">任务诊断信息</div>
      <div>状态：<span className="font-mono">{verificationStatus ?? "未开始"}</span></div>
      {contextSummary ? (
        <div>上下文：{contextSummary.includedCount} 项包含 · {contextSummary.omittedCount} 项省略 · {contextSummary.tokenEstimate} tok</div>
      ) : null}
      <div>证据：{evidenceCount} 条记录</div>
      {verdictSummary ? (
        <div>验收：通过 {verdictSummary.passed} · 失败 {verdictSummary.failed} · 缺失 {verdictSummary.missing} · 待审 {verdictSummary.needsReview}</div>
      ) : null}
      <div className="text-[10px] text-slate-400">
        详细证据和验收结果请通过 Run API 或 task-attempt API 查询
      </div>
    </div>
  );
}

/** P7: Verification status badge */
function VerificationBadge({ status }: { status: string }) {
  const styles: Record<string, { color: string; label: string; icon: ReactElement }> = {
    verified: { color: "text-emerald-700 bg-emerald-50", label: "已验证", icon: <CheckCircle2 className="h-3 w-3" /> },
    rejected: { color: "text-red-700 bg-red-50", label: "未通过", icon: <XCircle className="h-3 w-3" /> },
    checking: { color: "text-blue-700 bg-blue-50", label: "校验中", icon: <Loader2 className="h-3 w-3 animate-spin" /> },
    needs_review: { color: "text-amber-700 bg-amber-50", label: "待审查", icon: <AlertTriangle className="h-3 w-3" /> },
  };
  const s = styles[status] ?? { color: "text-slate-600 bg-slate-100", label: status, icon: <Circle className="h-3 w-3" /> };
  return (
    <span className={`flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium ${s.color}`}>
      {s.icon}{s.label}
    </span>
  );
}

function StatusIcon({ status }: { status: DispatchState["taskStatus"][string] }) {
  if (status === "running") return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-blue-600" />;
  if (status === "complete") return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />;
  if (status === "failed") return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />;
  if (status === "aborted") return <Ban className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />;
  if (status === "skipped") return <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />;
  if (status === "blocked") return <Ban className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />;
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />;
}

function StatusLabel({ status }: { status: DispatchState["taskStatus"][string] }) {
  const labels: Record<string, string> = { pending: "等待", running: "执行中", complete: "完成", failed: "失败", aborted: "已中止", skipped: "已跳过", blocked: "依赖阻塞" };
  return (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
      {status === "pending" ? <Clock3 className="mr-0.5 inline h-3 w-3" /> : null}
      {labels[status] ?? status}
    </span>
  );
}
