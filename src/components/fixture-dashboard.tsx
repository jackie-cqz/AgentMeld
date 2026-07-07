"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, AlertTriangle, BarChart3, ExternalLink } from "lucide-react";

interface FixtureSummary {
  fixtureId: string;
  runId: string;
  status: "passed" | "failed" | "error";
  evaluatedAt: number;
  durationMs?: number;
  metrics: {
    taskCount: number;
    completedTaskCount: number;
    upstreamInputReadCount: number;
    deploymentReadyCount: number;
    failedToolCallCount?: number;
    toolCallCount?: number;
  };
  warnings: string[];
}

interface DashboardData {
  summary: {
    totalFixtures: number;
    passed: number;
    failed: number;
    errors: number;
    overallPassRate: number;
  };
  recent: FixtureSummary[];
}

export function FixtureDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/context-metrics/fixture-report/history")
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => { setError("无法加载 Fixture 报告"); setLoading(false); });
  }, []);

  if (loading) return <div className="p-4 text-xs text-slate-400">加载中...</div>;
  if (error) return <div className="p-4 text-xs text-red-500">{error}</div>;
  if (!data || data.summary.totalFixtures === 0) return <div className="p-4 text-xs text-slate-400">暂无 Fixture 运行记录。运行 E2E 测试后这里会显示结果。</div>;

  // Per-fixture success rates
  const fixtureRates = new Map<string, { passed: number; total: number }>();
  for (const r of data.recent) {
    const entry = fixtureRates.get(r.fixtureId) ?? { passed: 0, total: 0 };
    entry.total++;
    if (r.status === "passed") entry.passed++;
    fixtureRates.set(r.fixtureId, entry);
  }

  // Average metrics
  const avgTasks = data.recent.length > 0 ? Math.round(data.recent.reduce((s, r) => s + (r.metrics?.taskCount ?? 0), 0) / data.recent.length) : 0;
  const avgReads = data.recent.length > 0 ? Math.round(data.recent.reduce((s, r) => s + (r.metrics?.upstreamInputReadCount ?? 0), 0) / data.recent.length) : 0;
  const avgDuration = data.recent.length > 0 ? Math.round(data.recent.reduce((s, r) => s + (r.durationMs ?? 0), 0) / data.recent.length / 1000) : 0;
  const avgToolFails = data.recent.length > 0 ? Math.round(data.recent.reduce((s, r) => s + (r.metrics?.failedToolCallCount ?? 0), 0) / data.recent.length) : 0;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-4">
      {/* Summary bar */}
      <div className="flex items-center gap-3">
        <BarChart3 className="h-5 w-5 text-blue-500" />
        <h3 className="text-sm font-medium text-slate-800">E2E 回归看板</h3>
        <span className="text-xs text-slate-400">{data.summary.totalFixtures} 次运行</span>
      </div>

      {/* Pass/fail counters */}
      <div className="grid grid-cols-4 gap-2">
        <StatBlock label="通过率" value={`${Math.round(data.summary.overallPassRate * 100)}%`} color="text-emerald-600" />
        <StatBlock label="通过" value={String(data.summary.passed)} color="text-emerald-600" />
        <StatBlock label="失败" value={String(data.summary.failed)} color="text-red-600" />
        <StatBlock label="错误" value={String(data.summary.errors)} color="text-amber-600" />
      </div>

      {/* Average metrics */}
      <div className="grid grid-cols-5 gap-2">
        <StatBlock label="平均任务数" value={String(avgTasks)} color="text-slate-600" />
        <StatBlock label="平均上游读取" value={String(avgReads)} color="text-slate-600" />
        <StatBlock label="平均耗时" value={`${avgDuration}s`} color="text-slate-600" />
        <StatBlock label="平均工具失败" value={String(avgToolFails)} color={avgToolFails > 2 ? "text-red-600" : "text-slate-600"} />
        <StatBlock label="Fixture 类型" value={String(fixtureRates.size)} color="text-slate-600" />
      </div>

      {/* Per-fixture success rate */}
      {fixtureRates.size > 0 && (
        <div>
          <h4 className="mb-2 text-[11px] font-medium text-slate-600">按 Fixture 成功率</h4>
          <div className="space-y-1">
            {Array.from(fixtureRates.entries()).map(([id, { passed, total }]) => (
              <div key={id} className="flex items-center justify-between text-[11px]">
                <span className="text-slate-600 truncate max-w-[200px]">{id}</span>
                <span className={`font-medium ${passed === total ? "text-emerald-600" : passed > 0 ? "text-amber-600" : "text-red-600"}`}>
                  {passed}/{total} ({total > 0 ? Math.round((passed / total) * 100) : 0}%)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent runs */}
      {data.recent.length > 0 && (
        <div>
          <h4 className="mb-2 text-[11px] font-medium text-slate-600">最近运行 ({data.recent.length})</h4>
          <div className="space-y-1 max-h-60 overflow-y-auto">
            {data.recent.map((r, i) => (
              <div key={i} className={`flex items-center gap-2 rounded border px-2 py-1 text-[11px] ${
                r.status === "passed" ? "border-emerald-100 bg-emerald-50/30" :
                r.status === "failed" ? "border-red-100 bg-red-50/30" : "border-amber-100 bg-amber-50/30"
              }`}>
                {r.status === "passed" ? <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" /> :
                 r.status === "failed" ? <XCircle className="h-3 w-3 text-red-500 shrink-0" /> :
                 <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />}
                <span className="text-slate-600 truncate flex-1">{r.fixtureId}</span>
                <span className="text-slate-400">{new Date(r.evaluatedAt).toLocaleTimeString()}</span>
                {r.status === "failed" && r.runId && (
                  <a href={`/api/context-trace/run/${r.runId}`} target="_blank" rel="noreferrer"
                     className="text-blue-500 hover:text-blue-700 shrink-0" title="查看 Trace">
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {r.warnings.length > 0 && (
                  <span className="text-amber-500 shrink-0" title={r.warnings.join("; ")}>
                    <AlertTriangle className="h-3 w-3" />
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* P6: Run-over-run comparison (latest vs previous) */}
          {data.recent.length >= 2 ? (
            <div className="mt-3 border-t border-slate-100 pt-2">
              <h4 className="mb-1.5 text-[11px] font-medium text-slate-600">最近两次对比</h4>
              <div className="grid grid-cols-2 gap-1 text-[10px]">
                {(() => {
                  const latest = data.recent[0];
                  const prev = data.recent[1];
                  const items = [
                    { label: "通过", prev: prev.status === "passed" ? 1 : 0, cur: latest.status === "passed" ? 1 : 0, unit: "" },
                    { label: "任务完成", prev: prev.metrics?.completedTaskCount ?? 0, cur: latest.metrics?.completedTaskCount ?? 0, unit: "" },
                    { label: "上游读取", prev: prev.metrics?.upstreamInputReadCount ?? 0, cur: latest.metrics?.upstreamInputReadCount ?? 0, unit: "" },
                    { label: "工具失败", prev: prev.metrics?.failedToolCallCount ?? 0, cur: latest.metrics?.failedToolCallCount ?? 0, unit: "", invert: true },
                  ];
                  return items.map((item) => {
                    const delta = item.cur - item.prev;
                    const deltaStr = delta > 0 ? `+${delta}` : String(delta);
                    const better = item.invert ? delta < 0 : delta > 0;
                    const same = delta === 0;
                    return (
                      <div key={item.label} className="flex items-center justify-between rounded border border-slate-100 px-1.5 py-0.5">
                        <span className="text-slate-500">{item.label}</span>
                        <span className={`font-medium ${same ? "text-slate-400" : better ? "text-emerald-600" : "text-red-600"}`}>
                          {deltaStr}{item.unit}
                        </span>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function StatBlock({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded border border-slate-100 bg-slate-50 px-2 py-1.5 text-center">
      <p className={`text-sm font-bold ${color}`}>{value}</p>
      <p className="text-[10px] text-slate-400">{label}</p>
    </div>
  );
}
