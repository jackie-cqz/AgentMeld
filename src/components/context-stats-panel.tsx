"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, Zap, Brain, FileText, ChevronDown } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { estimateTokens } from "@/shared/token-estimate";

interface Props {
  conversationId: string;
  onClose: () => void;
}

export function ContextStatsPanel({ conversationId, onClose }: Props) {
  const messagesByConversation = useAppStore((s) => s.messagesByConversation);
  const runsByConversation = useAppStore((s) => s.runsByConversation);
  const [compacting, setCompacting] = useState(false);
  const [compactResult, setCompactResult] = useState<string | null>(null);
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

  const messages = messagesByConversation[conversationId] ?? [];
  const runs = runsByConversation[conversationId] ?? [];

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

  const handleCompact = async () => {
    if (compacting) return;
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
          disabled={compacting}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#4169ff] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#3558e5] disabled:opacity-60"
        >
          {compacting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              正在压缩...
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
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          将早期消息压缩为 AI 摘要，保留关键决策和产物引用，降低后续对话 token 消耗。
        </p>
      </div>
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
