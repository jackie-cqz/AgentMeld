"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, Zap, Brain, FileText, ChevronDown } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/stores/app-store";
import { selectCompactionState, selectConversationMessages, selectConversationRuns } from "@/stores/selectors";
import { estimateTokens } from "@/shared/token-estimate";

interface Props {
  conversationId: string;
  onClose: () => void;
}

interface ContextBudgetPreview {
  estimatedTokens: number;
  summaryIncluded: boolean;
  summaryTokens: number;
  pinnedMessageCount: number;
  recentMessageCount: number;
  omittedMessageCount: number;
  totalCompleteMessages: number;
}

export function ContextStatsPanel({ conversationId, onClose }: Props) {
  const messages = useAppStore(useShallow((s) => selectConversationMessages(s, conversationId)));
  const runs = useAppStore(useShallow((s) => selectConversationRuns(s, conversationId)));
  const compactionState = useAppStore((s) => selectCompactionState(s, conversationId));
  const [compacting, setCompacting] = useState(false);
  const [compactResult, setCompactResult] = useState<string | null>(null);
  const [budgetPreview, setBudgetPreview] = useState<ContextBudgetPreview | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  useEffect(() => {
    fetch(`/api/conversations/${conversationId}/compact`, { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { preview?: ContextBudgetPreview }) => setBudgetPreview(data.preview ?? null))
      .catch(() => setBudgetPreview(null));
  }, [conversationId, compactionState?.updatedAt]);

  // Stats
  const totalMessages = messages.length;
  const userMessages = messages.filter((m) => m.role === "user").length;
  const agentMessages = messages.filter((m) => m.role === "agent").length;

  const totalInputTokens = runs.reduce((s, r) => s + (r.usage?.inputTokens ?? 0), 0);
  const totalOutputTokens = runs.reduce((s, r) => s + (r.usage?.outputTokens ?? 0), 0);
  const totalTokens = totalInputTokens + totalOutputTokens;

  // Estimate context tokens from message content
  const contextTokenEstimate = messages.reduce((sum, m) => {
    const text = m.parts
      .filter((p) => p.type === "text")
      .map((p) => p.content)
      .join("\n");
    return sum + estimateTokens(text);
  }, 0);

  const runningCount = runs.filter((r) => r.status === "running").length;
  const isCompacting = compacting || compactionState?.status === "running";

  const handleCompact = async () => {
    if (isCompacting) return;
    setCompacting(true);
    setCompactResult(null);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/compact`, { method: "POST" });
      const data = await res.json() as { compacted: boolean; reason?: string; sourceMessageCount?: number };
      if (data.compacted) {
        setCompactResult(`已启动压缩（${data.sourceMessageCount} 条消息），完成后会收到通知。`);
      } else {
        setCompactResult(data.reason ?? "无法压缩。");
      }
    } catch (err) {
      setCompactResult(`请求失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
    setCompacting(false);
  };

  return (
    <div ref={panelRef} className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-slate-200 bg-white shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-800">上下文统计</h3>
        <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      {/* Stats */}
      <div className="space-y-3 px-4 py-3">
        {/* Token overview */}
        <div className="grid grid-cols-2 gap-2">
          <StatBox icon={<Zap className="h-3.5 w-3.5" />} label="总 Token" value={formatNumber(totalTokens)} />
          <StatBox icon={<Brain className="h-3.5 w-3.5" />} label="上下文估算" value={formatNumber(contextTokenEstimate)} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <StatBox label="输入 Token" value={formatNumber(totalInputTokens)} />
          <StatBox label="输出 Token" value={formatNumber(totalOutputTokens)} />
        </div>

        {/* Message breakdown */}
        <div className="rounded-lg bg-slate-50 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-600">消息总数</span>
            <span className="font-mono font-medium text-slate-800">{totalMessages}</span>
          </div>
          <div className="mt-2 flex gap-3 text-xs">
            <span className="text-slate-500">
              用户 <span className="font-mono font-medium text-slate-700">{userMessages}</span>
            </span>
            <span className="text-slate-500">
              Agent <span className="font-mono font-medium text-slate-700">{agentMessages}</span>
            </span>
            <span className="text-slate-500">
              运行中 <span className="font-mono font-medium text-blue-600">{runningCount}</span>
            </span>
          </div>
        </div>

        {budgetPreview ? (
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-medium text-slate-700">下轮上下文预算预览</div>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <BudgetRow label="估算 Token" value={formatNumber(budgetPreview.estimatedTokens)} />
              <BudgetRow label="长期摘要" value={budgetPreview.summaryIncluded ? formatNumber(budgetPreview.summaryTokens) : "未生成"} />
              <BudgetRow label="置顶消息" value={String(budgetPreview.pinnedMessageCount)} />
              <BudgetRow label="近期消息" value={String(budgetPreview.recentMessageCount)} />
              <BudgetRow label="省略消息" value={String(budgetPreview.omittedMessageCount)} />
              <BudgetRow label="完整消息" value={String(budgetPreview.totalCompleteMessages)} />
            </div>
          </div>
        ) : null}

        {/* Model context window gauge */}
        <div className="rounded-lg bg-slate-50 p-3">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="text-slate-600">DeepSeek 上下文窗口 (64K)</span>
            <span className="font-mono font-medium text-slate-800">
              {Math.round((contextTokenEstimate / 65536) * 100)}%
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-200">
            <div
              className={`h-full rounded-full transition-all ${
                contextTokenEstimate > 55000
                  ? "bg-red-500"
                  : contextTokenEstimate > 40000
                    ? "bg-amber-500"
                    : "bg-emerald-500"
              }`}
              style={{ width: `${Math.min(100, (contextTokenEstimate / 65536) * 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* Compact action */}
      <div className="border-t border-slate-100 px-4 py-3">
        <button
          onClick={handleCompact}
          disabled={isCompacting}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#4169ff] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#3558e5] disabled:opacity-60"
        >
          {isCompacting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {compactionState?.stage ? formatCompactionStage(compactionState.stage) : "正在压缩..."}
            </>
          ) : (
            <>
              <FileText className="h-4 w-4" />
              压缩早期上下文
            </>
          )}
        </button>
        {compactResult && (
          <p className="mt-2 text-xs leading-relaxed text-slate-500">{compactResult}</p>
        )}
        {compactionState?.status === "running" && compactionState.detail ? (
          <p className="mt-2 text-xs leading-relaxed text-blue-600">{compactionState.detail}</p>
        ) : null}
        {compactionState?.status === "complete" && compactionState.tokenEstimate !== null ? (
          <p className="mt-2 text-xs leading-relaxed text-emerald-600">
            最近压缩完成，摘要约 {formatNumber(compactionState.tokenEstimate)} tokens。
          </p>
        ) : null}
        {compactionState?.status === "error" && compactionState.detail ? (
          <p className="mt-2 text-xs leading-relaxed text-red-600">{compactionState.detail}</p>
        ) : null}
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          将早期消息压缩为 AI 摘要，保留关键决策和产物引用，降低后续对话 token 消耗。
        </p>
      </div>
    </div>
  );
}

function BudgetRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono font-medium text-slate-800">{value}</span>
    </div>
  );
}

function StatBox({
  icon,
  label,
  value
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 font-mono text-sm font-semibold text-slate-800">{value}</div>
    </div>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCompactionStage(stage: "reading" | "summarizing" | "storing") {
  if (stage === "reading") return "读取上下文...";
  if (stage === "summarizing") return "生成摘要...";
  return "保存摘要...";
}
