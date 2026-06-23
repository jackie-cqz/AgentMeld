"use client";

import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  HelpCircle,
  Loader2,
  Rocket,
  Terminal,
  Wrench,
  XCircle
} from "lucide-react";
import { useState } from "react";
import type { MessagePart } from "@/shared/types";
import { getToolDisplayName } from "@/shared/tool-display";

type ToolUsePart = MessagePart & { type: "tool_use" };
type ToolResultPart = MessagePart & { type: "tool_result" };
type ToolCallEntry = { use: ToolUsePart; result?: ToolResultPart };

export function ToolUseCard({ parts, messageStatus }: { parts: MessagePart[]; messageStatus?: string }) {
  const [groupExpanded, setGroupExpanded] = useState(false);
  const toolCalls = new Map<string, ToolCallEntry>();

  for (const part of parts) {
    if (part.type === "tool_use") {
      if (!toolCalls.has(part.callId)) {
        toolCalls.set(part.callId, { use: part });
      }
    }
    if (part.type === "tool_result") {
      const entry = toolCalls.get(part.callId);
      if (entry) {
        entry.result = part;
      }
    }
  }

  if (toolCalls.size === 0) return null;

  const msgDone = messageStatus === "complete" || messageStatus === "error";
  const entries = Array.from(toolCalls.values());

  if (entries.length === 1) {
    const [{ use, result }] = entries;
    return (
      <ToolCallItem
        toolUse={use}
        toolResult={result}
        forceDone={msgDone && !result}
      />
    );
  }

  const summary = getToolGroupSummary(entries, msgDone);

  return (
    <div className={`overflow-hidden rounded-lg border text-sm ${summary.containerClass}`}>
      <button
        type="button"
        aria-expanded={groupExpanded}
        onClick={() => setGroupExpanded((expanded) => !expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ToolGroupStatusIcon status={summary.status} />
        <Wrench className="h-3.5 w-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
        <span className="min-w-0 flex-1 truncate font-medium text-stone-700 dark:text-slate-200">
          工具调用 × {entries.length}
        </span>
        <span className={`shrink-0 text-xs ${summary.statusClass}`}>{summary.label}</span>
        {groupExpanded
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-stone-400" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-stone-400" />}
      </button>

      {groupExpanded ? (
        <div className="divide-y divide-stone-200/80 border-t border-stone-200/80 bg-white/70 dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-950/40">
          {entries.map(({ use, result }) => (
            <ToolCallItem
              key={use.callId}
              toolUse={use}
              toolResult={result}
              forceDone={msgDone && !result}
              grouped
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToolCallItem({
  toolUse,
  toolResult,
  forceDone,
  grouped = false
}: {
  toolUse: ToolUsePart;
  toolResult?: ToolResultPart | undefined;
  forceDone?: boolean;
  grouped?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isBash = toolUse.toolName === "bash";
  const isFileWrite = toolUse.toolName === "fs_write";
  const isArtifactWrite = toolUse.toolName === "write_artifact";
  const isComplete = !!toolResult || forceDone;
  const isError = !forceDone && toolResult?.isError;
  const isPending = !isComplete;
  const args = toolUse.args as Record<string, unknown> | undefined;

  return (
    <div className={grouped ? "" : `overflow-hidden rounded-lg border text-sm ${
      isError ? "border-red-200 bg-red-50/80 dark:border-red-900/70 dark:bg-red-950/30" :
      isComplete ? "border-emerald-100 bg-emerald-50/70 dark:border-emerald-900/60 dark:bg-emerald-950/20" :
      "border-amber-200 bg-amber-50/80 dark:border-amber-900/70 dark:bg-amber-950/20"
    }`}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600" />
        ) : isError ? (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        )}
        <ToolIcon toolName={toolUse.toolName} />
        <span className="min-w-0 flex-1 truncate font-medium text-stone-700 dark:text-slate-200">
          {getToolDisplayName(toolUse.toolName)}
        </span>
        {isPending ? (
          <span className="text-xs text-amber-600">执行中...</span>
        ) : isError ? (
          <span className="text-xs text-red-500">失败</span>
        ) : (
          <span className="text-xs text-emerald-700 dark:text-emerald-400">已完成</span>
        )}
        {expanded
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-stone-400" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-stone-400" />}
      </button>

      {expanded ? (
        <div className="space-y-2 border-t border-stone-200/80 bg-white/70 px-3 py-2 dark:border-slate-700 dark:bg-slate-950/40">
          {isBash && args?.command ? (
            <div>
              <div className="mb-1 text-xs text-stone-500">命令</div>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-stone-950 p-2 font-mono text-xs text-stone-50">
                {String(args.command)}
              </pre>
            </div>
          ) : null}

          {!isBash && args ? (
            <div>
              <div className="mb-1 text-xs text-stone-500">参数</div>
              <pre className="max-h-32 overflow-x-auto whitespace-pre-wrap rounded bg-stone-100 p-2 font-mono text-xs text-stone-700 dark:bg-slate-900 dark:text-slate-200">
                {isFileWrite
                  ? `path: ${args.path ?? "?"} (${String(args.content ?? "").length} chars)`
                  : isArtifactWrite
                    ? formatArtifactArgs(args)
                    : JSON.stringify(args, null, 2).slice(0, 300)}
              </pre>
            </div>
          ) : null}

          {toolResult ? (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs text-stone-500">结果</span>
                <CopyButton text={formatResult(toolResult.result)} />
              </div>
              <StructuredToolResult
                toolName={toolUse.toolName}
                result={toolResult.result}
                isError={isError}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function getToolGroupSummary(entries: ToolCallEntry[], messageDone: boolean) {
  let pending = 0;
  let failed = 0;

  for (const entry of entries) {
    if (entry.result?.isError) {
      failed += 1;
    } else if (!entry.result && !messageDone) {
      pending += 1;
    }
  }

  if (pending > 0) {
    return {
      status: "pending" as const,
      label: `${pending} 个执行中`,
      statusClass: "text-amber-600",
      containerClass: "border-amber-200 bg-amber-50/80 dark:border-amber-900/70 dark:bg-amber-950/20"
    };
  }

  if (failed > 0) {
    return {
      status: "error" as const,
      label: `${failed} 个失败`,
      statusClass: "text-red-500",
      containerClass: "border-red-200 bg-red-50/80 dark:border-red-900/70 dark:bg-red-950/30"
    };
  }

  return {
    status: "complete" as const,
    label: "已完成",
    statusClass: "text-emerald-700 dark:text-emerald-400",
    containerClass: "border-emerald-100 bg-emerald-50/70 dark:border-emerald-900/60 dark:bg-emerald-950/20"
  };
}

function ToolGroupStatusIcon({ status }: { status: "pending" | "error" | "complete" }) {
  if (status === "pending") {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600" />;
  }
  if (status === "error") {
    return <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />;
  }
  return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
}

function formatArtifactArgs(args: Record<string, unknown>): string {
  if (typeof args.rawArguments === "string") {
    return `参数 JSON 解析失败\n${args.rawArguments.slice(0, 300)}`;
  }
  const contentLength = typeof args.content === "string"
    ? args.content.length
    : JSON.stringify(args.content ?? "").length;
  return `type: ${args.type ?? "?"}\ntitle: ${args.title ?? "?"}\ncontent: ${contentLength} chars`;
}

function ToolIcon({ toolName }: { toolName: string }) {
  if (toolName === "bash") return <Terminal className="h-3.5 w-3.5 shrink-0 text-stone-500" />;
  if (toolName === "fs_write" || toolName === "write_artifact") return <FileText className="h-3.5 w-3.5 shrink-0 text-blue-500" />;
  if (toolName === "ask_user") return <HelpCircle className="h-3.5 w-3.5 shrink-0 text-violet-500" />;
  if (toolName.startsWith("deploy_")) return <Rocket className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
  return null;
}

function StructuredToolResult({
  toolName,
  result,
  isError
}: {
  toolName: string;
  result: unknown;
  isError?: boolean;
}) {
  const value = unwrapToolResult(result);

  if (toolName === "bash" && isRecord(value)) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          <MetaBadge label={`exit ${String(value.exitCode ?? "?")}`} tone={value.exitCode === 0 ? "success" : "danger"} />
          <MetaBadge label={value.timedOut ? "超时" : "未超时"} tone={value.timedOut ? "danger" : "neutral"} />
          <MetaBadge label={value.truncated ? "输出已截断" : "完整输出"} tone={value.truncated ? "warning" : "neutral"} />
          {typeof value.cwd === "string" ? <MetaBadge label={value.cwd} tone="neutral" /> : null}
        </div>
        <BashOutput output={String(value.output ?? "")} isError={isError || value.exitCode !== 0} />
      </div>
    );
  }

  if (toolName === "fs_write" && isRecord(value)) {
    return (
      <div className="grid grid-cols-2 gap-2 rounded bg-stone-100 p-2 text-xs text-stone-700">
        <ResultField label="文件" value={String(value.path ?? "?")} />
        <ResultField label="写入" value={`${String(value.bytes ?? 0)} bytes`} />
        <ResultField label="模式" value={value.applied === "auto" ? "自动应用" : "审批后应用"} />
        <ResultField label="目录" value={String(value.cwd ?? "")} />
      </div>
    );
  }

  if (toolName === "ask_user" && isRecord(value)) {
    return (
      <div className="rounded bg-violet-50 p-2 text-xs text-violet-900">
        {Object.entries(value).map(([key, answer]) => (
          <div key={key} className="flex gap-2 py-0.5">
            <span className="font-medium">{key}</span>
            <span>{formatResult(answer)}</span>
          </div>
        ))}
      </div>
    );
  }

  if (toolName.startsWith("deploy_") && isRecord(value)) {
    const preview = typeof value.publicUrl === "string"
      ? value.publicUrl
      : typeof value.previewPath === "string"
        ? value.previewPath
        : null;
    return (
      <div className="rounded bg-emerald-50 p-2 text-xs text-emerald-900">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">{String(value.title ?? "部署")}</span>
          <span>{String(value.status ?? "")}</span>
        </div>
        {preview ? (
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.open(preview, "_blank")}
              className="flex items-center gap-1 rounded bg-white px-2 py-1 text-emerald-700"
            >
              <ExternalLink className="h-3 w-3" />打开
            </button>
            <CopyButton text={preview} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <pre className="max-h-40 overflow-x-auto whitespace-pre-wrap rounded bg-stone-100 p-2 font-mono text-xs text-stone-700">
      {formatResult(result).slice(0, 1000)}
    </pre>
  );
}

function BashOutput({ output, isError }: { output: string; isError?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className={`rounded p-2 text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-48 ${
        isError ? "bg-red-100 text-red-800" : "bg-stone-950 text-stone-50"
      }`}>
        {output || "(no output)"}
      </pre>
      <button
        onClick={() => { navigator.clipboard.writeText(output); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="absolute top-1 right-1 grid h-6 w-6 place-items-center rounded bg-stone-700 text-stone-300 hover:bg-stone-600"
        title="复制"
      >
        {copied ? <CheckCircle2 className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}

function MetaBadge({ label, tone }: { label: string; tone: "success" | "danger" | "warning" | "neutral" }) {
  const colors = {
    success: "bg-emerald-100 text-emerald-700",
    danger: "bg-red-100 text-red-700",
    warning: "bg-amber-100 text-amber-700",
    neutral: "bg-stone-100 text-stone-600"
  };
  return <span className={`max-w-full truncate rounded px-2 py-1 text-[10px] ${colors[tone]}`}>{label}</span>;
}

function ResultField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-stone-400">{label}</div>
      <div className="truncate font-mono" title={value}>{value}</div>
    </div>
  );
}

function unwrapToolResult(result: unknown): unknown {
  if (!isRecord(result)) return result;
  if ("value" in result) return result.value;
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-stone-400 hover:bg-stone-200"
    >
      {copied ? <CheckCircle2 className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "已复制" : "复制"}
    </button>
  );
}

function formatResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") return JSON.stringify(result, null, 2);
  return String(result);
}
