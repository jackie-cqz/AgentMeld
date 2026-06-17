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
      <details className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-600">
        <summary className="cursor-pointer font-medium text-slate-700">思考过程</summary>
        <p className="mt-2 whitespace-pre-wrap leading-6">{part.content || "正在整理上下文..."}</p>
      </details>
    );
  }

  if (part.type === "artifact_ref") {
    const setActiveArtifact = useAppStore.getState().setActiveArtifact;
    return (
      <button
        className="flex w-full items-center gap-3 rounded-lg border border-[#cfd9ff] bg-[#f4f7ff] px-3 py-2.5 text-left text-sm text-slate-800 transition hover:border-[#9db3ff] hover:bg-[#edf2ff]"
        type="button"
        onClick={() => setActiveArtifact(part.artifactId)}
        title="点击在右侧预览"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white text-[#4264ff] shadow-sm">
          <FileText className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{part.title ?? part.artifactId}</span>
          <span className="mt-0.5 block text-xs text-slate-500">点击在右侧工作区预览</span>
        </span>
        <span className="shrink-0 rounded-full bg-white px-2 py-1 text-xs text-slate-500">{part.artifactType ?? "artifact"}</span>
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
      <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-white text-blue-600">
          <Rocket className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 font-medium">{part.deployment.title}</span>
        <span className="rounded-full bg-white px-2 py-1 text-xs">{part.deployment.status}</span>
      </div>
    );
  }

  if (part.type === "deploy_candidates") {
    const handleDeploy = async (artifactId: string) => {
      await fetch("/api/artifacts/" + artifactId, { method: "GET" });
      window.open("/api/artifacts/" + artifactId + "/preview", "_blank");
    };
    return (
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm">
        <div className="font-medium text-blue-900 mb-2">选择要部署的产物</div>
        <div className="space-y-2">
          {part.candidates.map((candidate) => (
            <div key={candidate.artifactId} className="flex items-center justify-between rounded-lg bg-white border border-blue-100 px-3 py-2">
              <div>
                <span className="font-medium text-slate-800">{candidate.title}</span>
                <span className="ml-2 text-xs text-slate-500">v{candidate.version}</span>
              </div>
              <button
                onClick={() => handleDeploy(candidate.artifactId)}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                部署预览
              </button>
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
