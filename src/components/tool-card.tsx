"use client";

import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  GitBranch,
  Globe,
  HelpCircle,
  Loader2,
  MonitorCheck,
  Rocket,
  Search,
  Terminal,
  Wrench,
  XCircle
} from "lucide-react";
import { useState } from "react";
import type { MessagePart } from "@/shared/types";
import { getToolDisplayName } from "@/shared/tool-display";
import { summarizeToolCalls, toolCallState, toolCallStates, type ToolCallState } from "@/lib/tool-call-status";

type ToolUsePart = MessagePart & { type: "tool_use" };
type ToolResultPart = MessagePart & { type: "tool_result" };
type ToolCallEntry = { use: ToolUsePart; result?: ToolResultPart };

function isMessagePart(part: unknown): part is MessagePart {
  return !!part && typeof part === "object" && "type" in part;
}

export function ToolUseCard({ parts, messageStatus }: { parts: MessagePart[]; messageStatus?: string }) {
  const [groupExpanded, setGroupExpanded] = useState(false);
  const toolCalls = new Map<string, ToolCallEntry>();

  for (const part of parts.filter(isMessagePart)) {
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
  const states = toolCallStates(entries.map(entry => ({ toolName: entry.use.toolName, result: entry.result })), msgDone);

  return (
    <div className={`workspace-tool-call ${summary.status === "error" ? "has-error" : ""}`}>
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
        <span className={`tool-group-summary shrink-0 text-xs ${summary.statusClass}`}>{summary.label}</span>
        {groupExpanded
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-stone-400" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-stone-400" />}
      </button>

      {groupExpanded ? (
        <div className="divide-y divide-stone-200/80 border-t border-stone-200/80 bg-white/70 dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-950/40">
          {entries.map(({ use, result }, index) => (
            <ToolCallItem
              key={use.callId}
              toolUse={use}
              toolResult={result}
              forceDone={msgDone && !result}
              grouped
              state={states[index]}
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
  grouped = false,
  state
}: {
  toolUse: ToolUsePart;
  toolResult?: ToolResultPart | undefined;
  forceDone?: boolean;
  grouped?: boolean;
  state?: ToolCallState;
}) {
  const [expanded, setExpanded] = useState(false);
  const isBash = toolUse.toolName === "bash" || toolUse.toolName === "job_start";
  const resultValue = toolResult ? unwrapToolResult(toolResult.result) : null;
  const jobRunning = toolUse.toolName.startsWith("job_") && (state ? state === "running" : isRecord(resultValue) && resultValue.status === "running");
  const isFileWrite = toolUse.toolName === "fs_write" || toolUse.toolName === "fs_patch";
  const isArtifactWrite = toolUse.toolName === "write_artifact";
  const isComplete = !!toolResult || forceDone;
  const isError = (state ?? toolCallState(toolUse.toolName, toolResult, !!forceDone)) === "failed";
  const isPending = !isComplete || jobRunning;
  const args = toolUse.args as Record<string, unknown> | undefined;

  return (
    <div className={grouped ? "" : `workspace-tool-call ${isError ? "has-error" : ""}`}>
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
          <span className="text-xs text-amber-600">{jobRunning ? "命令运行中" : "执行中..."}</span>
        ) : isError ? (
          <span className="text-xs text-red-500">失败</span>
        ) : (
          <span className={`text-xs ${jobRunning ? "text-amber-600" : "text-emerald-700 dark:text-emerald-400"}`}>{jobRunning ? "命令运行中" : "已完成"}</span>
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
                  ? toolUse.toolName === "fs_patch"
                    ? `path: ${args.path ?? "?"}\noldText: ${String(args.oldText ?? "").length} chars\nnewText: ${String(args.newText ?? "").length} chars`
                    : `path: ${args.path ?? "?"} (${String(args.content ?? "").length} chars)`
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
  const summary = summarizeToolCalls(entries.map(entry => ({ toolName: entry.use.toolName, result: entry.result })), messageDone);
  const pending = summary.running;
  const failed = summary.failed;

  if (pending > 0 && failed === 0) {
    return {
      status: "pending" as const,
      label: summary.label,
      statusClass: "text-amber-600",
      containerClass: "border-amber-200 bg-amber-50/80 dark:border-amber-900/70 dark:bg-amber-950/20"
    };
  }

  if (failed > 0) {
    return {
      status: "error" as const,
      label: summary.label,
      statusClass: "text-red-500",
      containerClass: "border-red-200 bg-red-50/80 dark:border-red-900/70 dark:bg-red-950/30"
    };
  }

  return {
    status: "complete" as const,
    label: summary.label,
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
  if (toolName === "bash" || toolName.startsWith("job_")) return <Terminal className="h-3.5 w-3.5 shrink-0 text-stone-500" />;
  if (toolName === "fs_glob" || toolName === "fs_search") return <Search className="h-3.5 w-3.5 shrink-0 text-stone-500" />;
  if (toolName.startsWith("web_")) return <Globe className="h-3.5 w-3.5 shrink-0 text-stone-500" />;
  if (toolName === "git_inspect") return <GitBranch className="h-3.5 w-3.5 shrink-0 text-stone-500" />;
  if (toolName === "browser_check") return <MonitorCheck className="h-3.5 w-3.5 shrink-0 text-stone-500" />;
  if (toolName === "fs_write" || toolName === "fs_patch" || toolName === "write_artifact") return <FileText className="h-3.5 w-3.5 shrink-0 text-blue-500" />;
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

  if (toolName.startsWith("job_") && isRecord(value) && typeof value.jobId === "string") {
    const labels: Record<string, string> = { running: "运行中", completed: "已完成", failed: "执行失败", cancelled: "已取消", timed_out: "已超时" };
    return <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5"><MetaBadge label={labels[String(value.status)] ?? String(value.status)} tone={value.status === "running" ? "warning" : value.exitCode === 0 ? "success" : "danger"} /><MetaBadge label={`exit ${value.exitCode ?? "待定"}`} tone="neutral" /><MetaBadge label={String(value.jobId)} tone="neutral" /></div>
      <BashOutput output={String(value.output ?? "")} isError={value.status !== "running" && value.exitCode !== 0} />
      {value.logTruncated ? <p className="text-xs text-amber-700">日志达到保留上限</p> : null}
    </div>;
  }

  if (toolName === "browser_check" && isRecord(value) && typeof value.passed === "boolean") {
    const screenshot = typeof value.screenshotUrl === "string" && /^\/api\/browser-checks\/[a-f0-9-]{36}$/.test(value.screenshotUrl) ? value.screenshotUrl : null;
    return <div className="space-y-2 text-xs">
      <div className="flex flex-wrap gap-1.5"><MetaBadge label={value.passed ? "验收通过" : "验收未通过"} tone={value.passed ? "success" : "danger"} /><MetaBadge label={String(value.viewport)} tone="neutral" /><MetaBadge label={String(value.sourcePath)} tone="neutral" /></div>
      {screenshot ? <a href={screenshot} target="_blank" rel="noopener noreferrer" title="打开验收截图">
        {/* Browser-generated local PNG, never an arbitrary model-provided image URL. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={screenshot} alt="网页验收截图" className="max-h-64 w-auto max-w-full rounded border border-stone-200 object-contain dark:border-slate-700" />
      </a> : null}
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-stone-100 p-2 text-stone-700 dark:bg-slate-900 dark:text-slate-200">{formatResult({ steps: value.results, errors: value.errors, failedRequests: value.failedRequests, blockedRequests: value.blockedRequests }).slice(0, 12000)}</pre>
    </div>;
  }

  if ((toolName === "web_search" || toolName === "web_fetch") && isRecord(value)) {
    const sources = Array.isArray(value.results) ? value.results : [value];
    return <div className="space-y-2 text-xs">
      <MetaBadge label="外部资料 · 未验证" tone="warning" />
      {sources.filter(isRecord).slice(0, 10).map((source, index) => <div key={index} className="space-y-1 break-words">
        {typeof source.url === "string" && /^https?:\/\//i.test(source.url) ? <a className="text-blue-600 underline dark:text-blue-400" href={source.url} target="_blank" rel="noopener noreferrer">{String(source.title || source.url)}</a> : null}
        <p className="whitespace-pre-wrap text-stone-600 dark:text-slate-300">{String(source.snippet ?? source.content ?? "").slice(0, 3000)}</p>
      </div>)}
    </div>;
  }

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

  if ((toolName === "fs_write" || toolName === "fs_patch") && isRecord(value)) {
    return (
      <div className="grid grid-cols-2 gap-2 rounded bg-stone-100 p-2 text-xs text-stone-700">
        <ResultField label="文件" value={String(value.path ?? "?")} />
        <ResultField
          label={toolName === "fs_patch" ? "替换" : "写入"}
          value={toolName === "fs_patch"
            ? `${String(value.replacements ?? 0)} 处`
            : `${String(value.bytes ?? 0)} bytes`}
        />
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
      {formatResult(result).slice(0, 12000)}
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
