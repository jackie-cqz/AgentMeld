"use client";

import { CheckCircle2, ChevronDown, ChevronRight, Copy, Loader2, Terminal, XCircle } from "lucide-react";
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
        {isBash ? <Terminal className="h-3.5 w-3.5 shrink-0 text-stone-500" /> : null}
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
              {isBash ? (
                <BashOutput output={formatResult(toolResult.result)} isError={isError} />
              ) : (
                <pre className="rounded bg-stone-100 p-2 text-xs text-stone-700 overflow-x-auto font-mono whitespace-pre-wrap max-h-40">
                  {formatResult(toolResult.result).slice(0, 500)}
                </pre>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
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
