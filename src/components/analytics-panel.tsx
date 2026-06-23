"use client";

import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { BarChart3, Brain, Clock, Zap } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { selectAgentList, selectConversationList } from "@/stores/selectors";
import type { AgentRun } from "@/shared/types";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function timeAgo(ts: number, referenceTime: number): string {
  const diff = referenceTime - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

export function AnalyticsPanel() {
  const agents = useAppStore(useShallow(selectAgentList));
  const conversations = useAppStore(useShallow(selectConversationList));
  const allRunIds = useAppStore((s) => s.runIdsByConversation);
  const runsById = useAppStore((s) => s.runs);
  const [referenceTime] = useState(() => Date.now());

  // Flatten all runs from normalized store
  const allRuns = useMemo(() => {
    const runs: AgentRun[] = [];
    for (const ids of Object.values(allRunIds)) {
      for (const id of ids) {
        const run = runsById[id];
        if (run) runs.push(run);
      }
    }
    return runs;
  }, [allRunIds, runsById]);

  const runsByConvForStats = useMemo(() => {
    const map = new Map<string, AgentRun[]>();
    for (const run of allRuns) {
      const arr = map.get(run.conversationId) ?? [];
      arr.push(run);
      map.set(run.conversationId, arr);
    }
    return map;
  }, [allRuns]);

  // Aggregate stats
  const stats = useMemo(() => {
    const totalInput = allRuns.reduce((s, r) => s + (r.usage?.inputTokens ?? 0), 0);
    const totalOutput = allRuns.reduce((s, r) => s + (r.usage?.outputTokens ?? 0), 0);
    const total = totalInput + totalOutput;
    const completed = allRuns.filter((r) => r.status === "complete").length;
    const failed = allRuns.filter((r) => r.status === "failed" || r.status === "aborted").length;

    // By agent
    const byAgent = new Map<string, { name: string; tokens: number; runs: number }>();
    for (const r of allRuns) {
      const entry = byAgent.get(r.agentId) ?? { name: agents.find((a) => a.id === r.agentId)?.name ?? r.agentId, tokens: 0, runs: 0 };
      entry.tokens += (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
      entry.runs += 1;
      byAgent.set(r.agentId, entry);
    }
    const topAgents = [...byAgent.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .slice(0, 5);

    // By model (from usage.modelId)
    const byModel = new Map<string, { tokens: number; runs: number }>();
    for (const r of allRuns) {
      const model = r.usage?.modelId ?? "unknown";
      const entry = byModel.get(model) ?? { tokens: 0, runs: 0 };
      entry.tokens += (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
      entry.runs += 1;
      byModel.set(model, entry);
    }
    const topModels = [...byModel.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .slice(0, 5);

    // By conversation
    const byConv = new Map<string, { title: string; tokens: number; runs: number; lastActive: number }>();
    for (const [convId, runs] of runsByConvForStats) {
      const conv = conversations.find((c) => c.id === convId);
      let tokens = 0;
      let lastActive = 0;
      for (const r of runs) {
        tokens += (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
        if (r.updatedAt > lastActive) lastActive = r.updatedAt;
      }
      if (tokens > 0) {
        byConv.set(convId, { title: conv?.title ?? convId, tokens, runs: runs.length, lastActive });
      }
    }
    const topConvs = [...byConv.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .slice(0, 6);

    // Time-based: today / this week
    const today = new Date(referenceTime);
    const todayStart = today.setHours(0, 0, 0, 0);
    const weekStart = todayStart - 7 * 86400000;
    const todayTokens = allRuns
      .filter((r) => r.createdAt >= todayStart)
      .reduce((s, r) => s + (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0), 0);
    const weekTokens = allRuns
      .filter((r) => r.createdAt >= weekStart)
      .reduce((s, r) => s + (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0), 0);

    return { totalInput, totalOutput, total, completed, failed, topAgents, topModels, topConvs, todayTokens, weekTokens };
  }, [allRuns, agents, conversations, referenceTime, runsByConvForStats]);

  const darkMode = useAppStore((s) => s.darkMode);
  const muted = darkMode ? "text-slate-400" : "text-slate-500";
  const cardBg = darkMode ? "bg-slate-800" : "bg-slate-50";
  const textMain = darkMode ? "text-slate-100" : "text-slate-800";

  if (allRuns.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <BarChart3 className={`h-10 w-10 ${muted}`} />
        <p className={`text-sm ${muted}`}>暂无运行数据</p>
        <p className={`text-xs ${muted}`}>发起一次对话后，这里会显示 Token 用量统计</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      {/* Overview cards */}
      <div className="grid grid-cols-2 gap-2">
        <div className={`rounded-lg ${cardBg} p-3`}>
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <Zap className="h-3 w-3" /> 总 Token
          </div>
          <div className={`mt-1 text-lg font-semibold ${textMain}`}>{formatTokens(stats.total)}</div>
          <div className="mt-0.5 text-xs text-slate-500">
            输入 {formatTokens(stats.totalInput)} · 输出 {formatTokens(stats.totalOutput)}
          </div>
        </div>
        <div className={`rounded-lg ${cardBg} p-3`}>
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <Clock className="h-3 w-3" /> 运行次数
          </div>
          <div className={`mt-1 text-lg font-semibold ${textMain}`}>{allRuns.length}</div>
          <div className="mt-0.5 text-xs text-slate-500">
            ✅ {stats.completed} · ❌ {stats.failed}
          </div>
        </div>
      </div>

      {/* Time-based */}
      <div className={`mt-3 rounded-lg ${cardBg} p-3`}>
        <div className="mb-2 text-xs font-medium text-slate-500">Token 用量趋势</div>
        <div className="flex items-end gap-4">
          <div>
            <div className="text-xs text-slate-500">今日</div>
            <div className={`text-base font-semibold ${textMain}`}>{formatTokens(stats.todayTokens)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">近 7 天</div>
            <div className={`text-base font-semibold ${textMain}`}>{formatTokens(stats.weekTokens)}</div>
          </div>
        </div>
      </div>

      {/* Per LLM / Model */}
      <div className="mt-4">
        <h3 className={`mb-2 text-xs font-semibold uppercase tracking-wider ${muted}`}>
          <Brain className="mr-1 inline h-3 w-3" />按模型统计
        </h3>
        <div className="space-y-1">
          {stats.topModels.map(([model, data]) => (
            <div key={model} className={`flex items-center justify-between rounded-md px-3 py-2 ${cardBg}`}>
              <div className="min-w-0 flex-1">
                <div className={`truncate text-sm font-medium ${textMain}`}>{model}</div>
                <div className="text-xs text-slate-500">{data.runs} 次运行</div>
              </div>
              <div className={`text-sm font-mono font-semibold ${textMain}`}>{formatTokens(data.tokens)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Per Agent */}
      <div className="mt-4">
        <h3 className={`mb-2 text-xs font-semibold uppercase tracking-wider ${muted}`}>按 Agent 统计</h3>
        <div className="space-y-1">
          {stats.topAgents.map(([agentId, data]) => (
            <div key={agentId} className={`flex items-center justify-between rounded-md px-3 py-2 ${cardBg}`}>
              <div className="min-w-0 flex-1">
                <div className={`truncate text-sm font-medium ${textMain}`}>{data.name}</div>
                <div className="text-xs text-slate-500">{data.runs} 次运行</div>
              </div>
              <div className={`text-sm font-mono font-semibold ${textMain}`}>{formatTokens(data.tokens)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Top conversations */}
      <div className="mt-4 mb-6">
        <h3 className={`mb-2 text-xs font-semibold uppercase tracking-wider ${muted}`}>耗费最多 Token 的会话</h3>
        <div className="space-y-1">
          {stats.topConvs.map(([convId, data], idx) => (
            <div key={convId} className={`flex items-center gap-3 rounded-md px-3 py-2 ${cardBg}`}>
              <div className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${idx === 0 ? "bg-amber-500 text-white" : idx === 1 ? "bg-slate-400 text-white" : idx === 2 ? "bg-amber-700 text-white" : "bg-slate-300 text-slate-600"}`}>
                {idx + 1}
              </div>
              <div className="min-w-0 flex-1">
                <div className={`truncate text-sm font-medium ${textMain}`}>{data.title}</div>
                <div className="text-xs text-slate-500">{data.runs} 次运行 · {timeAgo(data.lastActive, referenceTime)}</div>
              </div>
              <div className={`text-sm font-mono font-semibold ${textMain}`}>{formatTokens(data.tokens)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
