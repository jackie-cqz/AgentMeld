"use client";

import { AlertTriangle, CheckCircle2, ChevronRight, CircleSlash2, ExternalLink, GitCompareArrows, RefreshCw, Scale, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface RunSummary {
  id: string;
  startedAt: number;
  finishedAt: number;
  caseIds: string[];
  strategies: string[];
  trialCount: number;
  passRate: number;
  finalStatus: "passed" | "failed" | "blocked" | "unknown";
  judgeMode: string;
  gitCommit: string;
  dirty: boolean;
}

interface RunDetail extends RunSummary {
  manifest: Record<string, unknown>;
  aggregate: Record<string, unknown>;
  comparison: Record<string, unknown> | null;
  qualityGates: Record<string, unknown> | null;
  trials: TrialRecord[];
}

interface AssertionReferenceView {
  artifactId?: string;
  evidenceId?: string;
  taskId?: string;
  attemptId?: string;
  toolCallId?: string;
  url?: string;
  filePath?: string;
}

interface TrialRecord extends Record<string, unknown> {
  caseId?: string;
  trialIndex?: number;
  conductorRunId?: string | null;
  durationMs?: number;
  verdict?: { deterministicVerdict?: string; semanticVerdict?: string; finalVerdict?: string; reason?: string };
  judge?: { status?: string; disagreement?: boolean; sampleResults?: unknown[]; result?: { weightedScore?: number; verdict?: string; confidence?: number; summary?: string; dimensions?: Array<{ dimension?: string; score?: number; reason?: string; evidenceRefs?: string[] }> } } | null;
  result?: { assertionResults?: Array<{ assertionId?: string; type?: string; status?: string; required?: boolean; reason?: string; references?: AssertionReferenceView[] }>; warnings?: string[]; metrics?: Record<string, number> };
}

type DashboardTab = "trials" | "metrics" | "comparison" | "judge" | "failures";

export function BenchmarkDashboard() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [tab, setTab] = useState<DashboardTab>("trials");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await requestRuns();
      setRuns(data.runs);
      setSelectedId((current) => current ?? data.runs[0]?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取 Benchmark 运行记录。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    requestRuns()
      .then((data) => {
        if (cancelled) return;
        setRuns(data.runs);
        setSelectedId(data.runs[0]?.id ?? null);
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "无法读取 Benchmark 运行记录。"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    fetch(`/api/benchmarks/${encodeURIComponent(selectedId)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ run: RunDetail }>;
      })
      .then((data) => { if (!cancelled) setDetail(data.run); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "无法读取运行详情。"); });
    return () => { cancelled = true; };
  }, [selectedId]);

  return (
    <div className="mx-auto flex min-h-[calc(100vh-74px)] max-w-[1600px] max-lg:flex-col">
      <aside className="w-80 shrink-0 border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 max-lg:w-full max-lg:border-b max-lg:border-r-0">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div>
            <div className="text-sm font-semibold">最近运行</div>
            <div className="text-xs text-slate-500">{runs.length} 个本地报告</div>
          </div>
          <button type="button" onClick={() => void loadRuns()} className="grid h-8 w-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" title="刷新">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[calc(100vh-140px)] overflow-y-auto p-2 max-lg:max-h-64">
          {loading ? <div className="px-3 py-8 text-center text-sm text-slate-400">读取报告中...</div> : null}
          {!loading && runs.length === 0 ? <div className="px-3 py-8 text-center text-sm text-slate-400">尚未生成 Benchmark 报告。</div> : null}
          {runs.map((run) => (
            <button key={run.id} type="button" onClick={() => { setDetail(null); setSelectedId(run.id); }} className={`mb-1 flex w-full items-center gap-3 rounded-md px-3 py-3 text-left ${selectedId === run.id ? "bg-blue-50 text-blue-950 dark:bg-blue-500/10 dark:text-blue-100" : "hover:bg-slate-50 dark:hover:bg-slate-800"}`}>
              <StatusIcon status={run.finalStatus} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{run.caseIds.join(", ") || run.id}</span>
                <span className="mt-0.5 block text-xs text-slate-500">{formatDate(run.startedAt)} · {run.trialCount} trials</span>
              </span>
              <ChevronRight className="h-4 w-4 text-slate-300" />
            </button>
          ))}
        </div>
      </aside>

      <section className="min-w-0 flex-1">
        {error ? <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm text-red-700">{error}</div> : null}
        {!detail ? <div className="grid min-h-[560px] place-items-center text-sm text-slate-400">选择一条运行记录查看详情。</div> : <RunView detail={detail} tab={tab} onTabChange={setTab} />}
      </section>
    </div>
  );
}

function RunView({ detail, tab, onTabChange }: { detail: RunDetail; tab: DashboardTab; onTabChange: (tab: DashboardTab) => void }) {
  const failedTrials = detail.trials.filter((trial) => trial.verdict?.finalVerdict !== "passed");
  const judgeTrials = detail.trials.filter((trial) => trial.judge?.status && trial.judge.status !== "disabled");
  const tabs: Array<{ id: DashboardTab; label: string; count?: number }> = [
    { id: "trials", label: "Trials", count: detail.trials.length },
    { id: "metrics", label: "Metrics" },
    { id: "comparison", label: "Strategy Comparison" },
    { id: "judge", label: "Judge Review", count: judgeTrials.length },
    { id: "failures", label: "Failures", count: failedTrials.length },
  ];
  return (
    <>
      <div className="border-b border-slate-200 bg-white px-6 py-5 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2"><StatusIcon status={detail.finalStatus} /><h2 className="text-lg font-semibold">{detail.id}</h2></div>
            <p className="mt-1 text-sm text-slate-500">{detail.caseIds.join(" · ")} · {detail.strategies.join(" vs ")}</p>
          </div>
          <div className="text-right text-xs text-slate-500">Git {detail.gitCommit.slice(0, 8)}{detail.dirty ? " · dirty" : ""}<br />Judge: {detail.judgeMode}</div>
        </div>
        <div className="mt-5 grid grid-cols-4 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 dark:border-slate-700 dark:bg-slate-700 max-md:grid-cols-2">
          <Metric label="Final pass rate" value={formatPercent(detail.passRate)} />
          <Metric label="Trials" value={String(detail.trialCount)} />
          <Metric label="Duration" value={formatDuration(detail.finishedAt - detail.startedAt)} />
          <Metric label="Failures" value={String(failedTrials.length)} />
        </div>
      </div>
      <div className="flex overflow-x-auto border-b border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-900">
        {tabs.map((item) => <button key={item.id} type="button" onClick={() => onTabChange(item.id)} className={`h-11 whitespace-nowrap border-b-2 px-3 text-sm ${tab === item.id ? "border-blue-600 font-medium text-blue-700 dark:text-blue-300" : "border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"}`}>{item.label}{item.count != null ? ` ${item.count}` : ""}</button>)}
      </div>
      <div className="p-6">
        {tab === "trials" ? <TrialList trials={detail.trials} /> : null}
        {tab === "metrics" ? <JsonTable value={detail.aggregate} empty="没有聚合指标。" /> : null}
        {tab === "comparison" ? detail.comparison ? <JsonTable value={detail.comparison} empty="" /> : <Empty text="本次运行没有执行 Context Strategy A/B。" icon={<GitCompareArrows className="h-5 w-5" />} /> : null}
        {tab === "judge" ? <JudgeReview trials={judgeTrials} /> : null}
        {tab === "failures" ? <TrialList trials={failedTrials} failuresOnly /> : null}
      </div>
    </>
  );
}

function TrialList({ trials, failuresOnly = false }: { trials: TrialRecord[]; failuresOnly?: boolean }) {
  if (trials.length === 0) return <Empty text={failuresOnly ? "没有失败 Trial。" : "没有 Trial 数据。"} icon={<CheckCircle2 className="h-5 w-5" />} />;
  return <div className="space-y-3">{trials.map((trial, index) => {
    const verdict = trial.verdict?.finalVerdict ?? "unknown";
    const failedAssertions = trial.result?.assertionResults?.filter((assertion) => assertion.status !== "passed") ?? [];
    return <article key={`${trial.caseId}-${trial.trialIndex}-${index}`} className="rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <StatusIcon status={verdict} /><div className="min-w-0 flex-1"><div className="text-sm font-semibold">{trial.caseId} · Trial {trial.trialIndex}</div><div className="text-xs text-slate-500">{formatDuration(trial.durationMs ?? 0)} · Hard Gate {trial.verdict?.deterministicVerdict ?? "unknown"} · Judge {trial.verdict?.semanticVerdict ?? "not_requested"}</div></div>
        {trial.conductorRunId ? <a href={`/api/context-trace/run/${trial.conductorRunId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800">Context Trace <ExternalLink className="h-3 w-3" /></a> : null}
      </div>
      <div className="px-4 py-3 text-sm text-slate-600 dark:text-slate-300">
        <p>{trial.verdict?.reason ?? "No verdict reason."}</p>
        {failedAssertions.map((assertion, assertionIndex) => <div key={`${assertion.assertionId}-${assertionIndex}`} className="mt-2 border-l-2 border-red-300 pl-3 text-xs"><span className="font-semibold text-red-700 dark:text-red-300">{assertion.type}: {assertion.assertionId}</span><span className="ml-2">{assertion.reason}</span>{assertion.references?.length ? <div className="mt-1 flex flex-wrap gap-2 font-mono text-slate-400">{assertion.references.map((reference, referenceIndex) => <AssertionReferenceLink key={referenceIndex} reference={reference} />)}</div> : null}</div>)}
      </div>
    </article>;
  })}</div>;
}

function JudgeReview({ trials }: { trials: TrialRecord[] }) {
  if (trials.length === 0) return <Empty text="本次运行没有启用 Codex Judge。" icon={<Scale className="h-5 w-5" />} />;
  const reviewQueue = trials.filter((trial) =>
    trial.judge?.status === "failed" ||
    trial.judge?.status === "pending" ||
    trial.judge?.disagreement ||
    trial.judge?.result?.verdict === "needs_human_review"
  );
  return <div className="space-y-5">
    <section className={`rounded-md border p-4 ${reviewQueue.length ? "border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20" : "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/20"}`}>
      <div className="flex items-center gap-2 text-sm font-semibold">{reviewQueue.length ? <AlertTriangle className="h-4 w-4 text-amber-600" /> : <CheckCircle2 className="h-4 w-4 text-emerald-600" />}人工复核队列 · {reviewQueue.length}</div>
      {reviewQueue.length ? <div className="mt-2 flex flex-wrap gap-2">{reviewQueue.map((trial, index) => <span key={`${trial.caseId}-${index}`} className="rounded bg-white px-2 py-1 text-xs dark:bg-slate-900">{trial.caseId} · Trial {trial.trialIndex}</span>)}</div> : <p className="mt-1 text-xs text-slate-500">没有低置信度、分歧、待导入或执行失败的 Judge 结果。</p>}
    </section>
    {trials.map((trial, index) => <article key={`${trial.caseId}-${index}`} className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"><div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">{trial.caseId} · Trial {trial.trialIndex}</h3><p className="mt-1 text-xs text-slate-500">状态 {trial.judge?.status} · verdict {trial.judge?.result?.verdict ?? "pending"} · 置信度 {formatPercent(trial.judge?.result?.confidence ?? 0)}{trial.judge?.sampleResults?.length ? ` · ${trial.judge.sampleResults.length} samples` : ""}</p></div><div className="text-2xl font-semibold">{trial.judge?.result?.weightedScore ?? "-"}</div></div><p className="mt-3 text-sm text-slate-600 dark:text-slate-300">{trial.judge?.result?.summary ?? "等待 Judge 结果。"}</p><div className="mt-3 divide-y divide-slate-100 border-y border-slate-100 dark:divide-slate-800 dark:border-slate-800">{trial.judge?.result?.dimensions?.map((dimension) => <div key={dimension.dimension} className="grid grid-cols-[180px_48px_minmax(0,1fr)] gap-3 py-2 text-xs max-md:grid-cols-1"><span className="font-medium">{dimension.dimension}</span><span>{dimension.score}/4</span><span className="text-slate-500">{dimension.reason}<span className="ml-2 inline-flex flex-wrap gap-1 font-mono text-slate-400">{dimension.evidenceRefs?.map((reference) => <JudgeEvidenceLink key={reference} reference={reference} />)}</span></span></div>)}</div></article>)}
  </div>;
}

function JudgeEvidenceLink({ reference }: { reference: string }) {
  const separator = reference.indexOf(":");
  const kind = separator >= 0 ? reference.slice(0, separator) : "";
  const id = separator >= 0 ? reference.slice(separator + 1) : reference;
  const href = kind === "artifact" ? `/api/artifacts/${encodeURIComponent(id)}` : kind === "evidence" ? `/api/evidence/${encodeURIComponent(id)}` : null;
  return href ? <a href={href} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{reference}</a> : <span>{reference}</span>;
}

function AssertionReferenceLink({ reference }: { reference: AssertionReferenceView }) {
  const href = reference.artifactId ? `/api/artifacts/${encodeURIComponent(reference.artifactId)}` : reference.evidenceId ? `/api/evidence/${encodeURIComponent(reference.evidenceId)}` : reference.url ?? null;
  const label = reference.artifactId ? `artifact:${reference.artifactId}` : reference.evidenceId ? `evidence:${reference.evidenceId}` : reference.taskId ? `task:${reference.taskId}` : reference.toolCallId ? `tool:${reference.toolCallId}` : reference.url ?? reference.filePath ?? "reference";
  return href ? <a href={href} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{label}</a> : <span>{label}</span>;
}

function JsonTable({ value, empty }: { value: Record<string, unknown>; empty: string }) {
  const entries = Object.entries(value).filter(([, item]) => typeof item !== "object" || item === null);
  if (entries.length === 0 && empty) return <Empty text={empty} icon={<CircleSlash2 className="h-5 w-5" />} />;
  return <div className="overflow-hidden rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"><div className="grid grid-cols-2 divide-x divide-y divide-slate-100 dark:divide-slate-800 max-md:grid-cols-1">{entries.map(([key, item]) => <div key={key} className="flex items-center justify-between gap-4 px-4 py-3 text-sm"><span className="text-slate-500">{key}</span><span className="font-mono font-medium">{formatValue(item)}</span></div>)}</div><details className="border-t border-slate-100 px-4 py-3 dark:border-slate-800"><summary className="cursor-pointer text-xs font-medium text-slate-500">查看完整 JSON</summary><pre className="mt-3 max-h-[520px] overflow-auto text-xs text-slate-600 dark:text-slate-300">{JSON.stringify(value, null, 2)}</pre></details></div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="bg-white px-4 py-3 dark:bg-slate-900"><div className="text-xs text-slate-500">{label}</div><div className="mt-1 text-xl font-semibold">{value}</div></div>; }
function Empty({ text, icon }: { text: string; icon: React.ReactNode }) { return <div className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-slate-300 text-sm text-slate-400 dark:border-slate-700">{icon}{text}</div>; }
function StatusIcon({ status }: { status: string }) { if (status === "passed") return <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />; if (status === "blocked") return <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />; return <XCircle className="h-5 w-5 shrink-0 text-red-500" />; }
function formatPercent(value: number) { return `${Math.round(value * 100)}%`; }
function formatDuration(value: number) { return value >= 60_000 ? `${(value / 60_000).toFixed(1)}m` : `${(value / 1000).toFixed(1)}s`; }
function formatDate(value: number) { return value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未知时间"; }
function formatValue(value: unknown) { if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(3); if (typeof value === "boolean") return value ? "true" : "false"; return String(value ?? "-"); }

async function requestRuns(): Promise<{ runs: RunSummary[] }> {
  const response = await fetch("/api/benchmarks", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<{ runs: RunSummary[] }>;
}
