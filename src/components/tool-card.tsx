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
  XCircle
} from "lucide-react";
import { useState } from "react";
import type { MessagePart } from "@/shared/types";

export function ToolUseCard({ parts }: { parts: MessagePart[] }) {
  // Group parts: find tool_use and matching tool_result
  const toolCalls = new Map<string, { use: MessagePart & { type: "tool_use" }; result?: MessagePart & { type: "tool_result" } }>();

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

  return (
    <div className="space-y-2">
      {Array.from(toolCalls.values()).map(({ use, result }) => (
        <ToolCallItem key={use.callId} toolUse={use} toolResult={result} />
      ))}
    </div>
  );
}

function ToolCallItem({
  toolUse,
  toolResult
}: {
  toolUse: MessagePart & { type: "tool_use" };
  toolResult?: (MessagePart & { type: "tool_result" }) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const isBash = toolUse.toolName === "bash";
  const isWrite = toolUse.toolName === "fs_write" || toolUse.toolName === "write_artifact";
  const isComplete = !!toolResult;
  const isError = toolResult?.isError;
  const isPending = !toolResult;

  const args = toolUse.args as Record<string, unknown> | undefined;

  return (
    <div className={`rounded-md border text-sm ${
      isError ? "border-red-200 bg-red-50" :
      isComplete ? "border-stone-200 bg-stone-50" :
      "border-amber-200 bg-amber-50"
    }`}>
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
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
        <span className="font-medium text-stone-700 truncate flex-1">
          {isBash ? "Shell" : toolUse.toolName}
        </span>
        {isPending ? (
          <span className="text-xs text-amber-600">执行中...</span>
        ) : isError ? (
          <span className="text-xs text-red-500">失败</span>
        ) : (
          <span className="text-xs text-stone-400">完成</span>
        )}
        {expanded ? <ChevronDown className="h-3.5 w-3.5 text-stone-400" /> : <ChevronRight className="h-3.5 w-3.5 text-stone-400" />}
      </button>

      {/* Expanded detail */}
      {expanded ? (
        <div className="border-t border-stone-200 px-3 py-2 space-y-2">
          {/* Bash: show command */}
          {isBash && args?.command ? (
            <div>
              <div className="text-xs text-stone-500 mb-1">命令</div>
              <pre className="rounded bg-stone-950 p-2 text-xs text-stone-50 overflow-x-auto font-mono whitespace-pre-wrap">
                {String(args.command)}
              </pre>
            </div>
          ) : null}

          {/* Other tools: show args */}
          {!isBash && args ? (
            <div>
              <div className="text-xs text-stone-500 mb-1">参数</div>
              <pre className="rounded bg-stone-100 p-2 text-xs text-stone-700 overflow-x-auto font-mono whitespace-pre-wrap max-h-32">
                {isWrite
                  ? `path: ${args.path ?? "?"} (${String(args.content ?? "").length} chars)`
                  : JSON.stringify(args, null, 2).slice(0, 300)}
              </pre>
            </div>
          ) : null}

          {/* Result */}
          {toolResult ? (
            <div>
              <div className="flex items-center justify-between mb-1">
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
