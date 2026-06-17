"use client";

import { File, FileText, Image, Loader2, Rocket, TerminalSquare } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { ToolUseCard } from "@/components/tool-card";
import type { MessagePart } from "@/shared/types";

export function MessageParts({ parts }: { parts: MessagePart[] }) {
  if (parts.length === 0) {
    return <div className="h-5 w-40 animate-pulse rounded bg-stone-200" />;
  }

  // Separate tool calls from regular parts for merged rendering
  const toolCallIds = new Set(parts.filter((p) => p.type === "tool_use" || p.type === "tool_result").map((p) => p.type === "tool_use" ? p.callId : (p as { callId: string }).callId));
  const nonToolParts = parts.filter((p) => p.type !== "tool_use" && p.type !== "tool_result");

  return (
    <div className="space-y-3">
      {nonToolParts.map((part, index) => (
        <MessagePartView key={`${part.type}-${index}`} part={part} />
      ))}
      {toolCallIds.size > 0 ? <ToolUseCard parts={parts} /> : null}
    </div>
  );
}

function MessagePartView({ part }: { part: MessagePart }) {
  if (part.type === "text") {
    return part.content ? (
      <MarkdownRenderer content={part.content} />
    ) : (
      <Loader2 className="h-4 w-4 animate-spin text-stone-400" />
    );
  }

  if (part.type === "thinking") {
    return (
      <details className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" open>
        <summary className="cursor-pointer font-medium">思考过程</summary>
        <p className="mt-2 whitespace-pre-wrap leading-6">{part.content || "正在整理上下文..."}</p>
      </details>
    );
  }

  if (part.type === "artifact_ref") {
    const setActiveArtifact = useAppStore.getState().setActiveArtifact;
    return (
      <button
        className="flex w-full items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-left text-sm text-emerald-900 hover:bg-emerald-100 transition cursor-pointer"
        type="button"
        onClick={() => setActiveArtifact(part.artifactId)}
        title="点击在右侧预览"
      >
        <FileText className="h-4 w-4 shrink-0" />
        <span className="font-medium truncate">{part.title ?? part.artifactId}</span>
        <span className="shrink-0 text-emerald-700">{part.artifactType ?? "artifact"}</span>
      </button>
    );
  }

  if (part.type === "tool_use") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-700">
        <TerminalSquare className="h-4 w-4" />
        <span>{part.toolName}</span>
      </div>
    );
  }

  if (part.type === "deploy_status") {
    return (
      <div className="flex items-center gap-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
        <Rocket className="h-4 w-4" />
        <span className="font-medium">{part.deployment.title}</span>
        <span>{part.deployment.status}</span>
      </div>
    );
  }

  if (part.type === "deploy_candidates") {
    return (
      <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
        <div className="font-medium">可部署产物</div>
        <div className="mt-2 space-y-1">
          {part.candidates.map((candidate) => (
            <div key={candidate.artifactId}>
              {candidate.title} · v{candidate.version}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (part.type === "image_attachment" || part.type === "file_attachment") {
    const Icon = part.type === "image_attachment" ? Image : File;
    return (
      <div className="flex items-center gap-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-700">
        <Icon className="h-4 w-4" />
        <span className="font-medium">{part.fileName}</span>
        <span>{formatBytes(part.size)}</span>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-700">
      未知消息：{JSON.stringify(part)}
    </div>
  );
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
