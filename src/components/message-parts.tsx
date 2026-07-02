"use client";

import { Check, Copy, Download, ExternalLink, File, FileText, Image, Loader2, Rocket, RotateCcw, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { useAppStore } from "@/stores/app-store";
import { requestJson } from "@/lib/request-json";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { ToolUseCard } from "@/components/tool-card";
import type { MessagePart } from "@/shared/types";

export function MessageParts({ parts, messageStatus }: { parts: MessagePart[]; messageStatus?: string }) {
  if (parts.length === 0) {
    return <div className="h-5 w-40 animate-pulse rounded bg-stone-200" />;
  }

  // Separate tool calls from regular parts for merged rendering
  const toolCallIds = new Set(parts.filter((p) => p.type === "tool_use" || p.type === "tool_result").map((p) => p.type === "tool_use" ? p.callId : (p as { callId: string }).callId));
  const nonToolParts = parts.filter((p) => p.type !== "tool_use" && p.type !== "tool_result");
  const hasVerifiedDeployment = parts.some((part) => part.type === "deploy_status");

  return (
    <div className="space-y-3">
      {nonToolParts.map((part, index) => (
        <MessagePartView
          key={`${part.type}-${index}`}
          part={part}
          hasVerifiedDeployment={hasVerifiedDeployment}
        />
      ))}
      {toolCallIds.size > 0 ? <ToolUseCard parts={parts} messageStatus={messageStatus} /> : null}
    </div>
  );
}

function MessagePartView({
  part,
  hasVerifiedDeployment
}: {
  part: MessagePart;
  hasVerifiedDeployment: boolean;
}) {
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  if (part.type === "text") {
    if (hasVerifiedDeployment && looksLikeUnverifiedDeploymentClaim(part.content)) {
      return null;
    }
    if (!hasVerifiedDeployment && looksLikeUnverifiedDeploymentClaim(part.content)) {
      return <UnverifiedDeploymentClaim content={part.content} />;
    }
    return part.content ? (
      <MarkdownRenderer content={part.content} />
    ) : (
      <Loader2 className="h-4 w-4 animate-spin text-stone-400" />
    );
  }

  if (part.type === "thinking") {
    return (
      <details className="rounded-lg border border-dashed border-slate-300 bg-slate-50/80 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-300">
        <summary className="cursor-pointer text-xs font-medium text-slate-500 dark:text-slate-400">思考</summary>
        <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-slate-500 dark:text-slate-400">{part.content || "正在整理上下文..."}</p>
      </details>
    );
  }

  if (part.type === "artifact_ref") {
    return <ArtifactReferenceCard part={part} />;
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
    return <DeploymentCard deployment={part.deployment} conversationId={activeConversationId} />;
  }

  if (part.type === "deploy_candidates") {
    return <DeployCandidates candidates={part.candidates} conversationId={activeConversationId} />;
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

function UnverifiedDeploymentClaim({ content }: { content: string }) {
  const path = content.match(/\/deployments\/dep_[a-zA-Z0-9_-]+/)?.[0];
  const artifactId = content.match(/\bart_[a-zA-Z0-9_-]+\b/)?.[0];

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-950">
      <div className="flex items-center gap-2 font-medium">
        <TerminalSquare className="h-4 w-4" />
        部署结果未确认
      </div>
      <p className="mt-2 leading-6">
        这条回复声称部署成功，但消息中没有收到真实的部署工具事件。请让 Agent 重新调用
        <code className="mx-1 rounded bg-white/70 px-1 py-0.5">deploy_workspace</code>
        ，不要手写部署路径或产物 id。
      </p>
      {path || artifactId ? (
        <div className="mt-2 space-y-1 text-xs text-amber-800">
          {path ? <div>未验证路径：<code>{path}</code></div> : null}
          {artifactId ? <div>未验证产物：<code>{artifactId}</code></div> : null}
        </div>
      ) : null}
    </div>
  );
}

function looksLikeUnverifiedDeploymentClaim(content: string) {
  if (!content) return false;
  const hasDeploymentMarker = /\/deployments\/dep_[a-zA-Z0-9_-]+/.test(content) ||
    /\[部署预览[:：]/.test(content) ||
    /\[产物[:：].*\bart_[a-zA-Z0-9_-]+\b/.test(content);
  const claimsSuccess = /部署成功|重新部署成功|已可预览|应用已可预览|应用已就绪|最新预览地址/.test(content);
  return hasDeploymentMarker && claimsSuccess;
}

function ArtifactReferenceCard({ part }: { part: Extract<MessagePart, { type: "artifact_ref" }> }) {
  const artifact = useAppStore((state) => state.artifacts[part.artifactId] ?? null);
  const applyEvent = useAppStore((state) => state.applyEvent);
  const setActiveArtifact = useAppStore((state) => state.setActiveArtifact);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setLoading(true);
    setError(null);
    try {
      let resolved = artifact;
      if (!resolved) {
        const data = await requestJson<{ artifact: import("@/shared/types").Artifact }>(
          `/api/artifacts/${part.artifactId}`
        );
        resolved = data.artifact;
        applyEvent({
          type: "artifact.create",
          conversationId: resolved.conversationId,
          timestamp: Date.now(),
          artifact: resolved
        });
      }
      setActiveArtifact(resolved.id);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "产物加载失败。");
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition ${
        error ? "border-red-200 bg-red-50 text-red-800" : "border-[#cfd9ff] bg-[#f4f7ff] text-slate-800 hover:border-[#9db3ff] hover:bg-[#edf2ff]"
      }`}
      type="button"
      onClick={() => void open()}
      title={error ? "产物加载失败，点击重试" : "点击在右侧预览"}
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white text-[#4264ff] shadow-sm">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{part.title ?? part.artifactId}</span>
        <span className="mt-0.5 block text-xs opacity-70">{error ?? "点击在右侧工作区预览"}</span>
      </span>
      <span className="shrink-0 rounded-full bg-white px-2 py-1 text-xs text-slate-500">{part.artifactType ?? "artifact"}</span>
    </button>
  );
}

function DeploymentCard({
  deployment,
  conversationId
}: {
  deployment: Extract<MessagePart, { type: "deploy_status" }>["deployment"];
  conversationId: string | null;
}) {
  const previewUrl = deployment.publicUrl ?? deployment.previewPath;
  const localPreviewUrl = deployment.localPreviewPath ?? "";
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = async () => {
    if (!conversationId) return;
    setRetrying(true);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactId: deployment.artifactId })
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "重新部署失败。");
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "重新部署失败。");
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div className={`rounded-lg border px-3 py-3 text-sm ${deployment.status === "failed" ? "border-red-200 bg-red-50 text-red-900" : "border-blue-200 bg-blue-50 text-blue-900"}`}>
      <div className="flex items-center gap-3">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-white text-blue-600"><Rocket className="h-4 w-4" /></span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{deployment.title}</span>
          <span className="block truncate text-xs opacity-75">
            {deployment.deploymentType === "external_static" ? "外部静态发布" : "本地预览"} · v{deployment.version}
          </span>
        </span>
        <span className="rounded-full bg-white px-2 py-1 text-xs">{deployment.status}</span>
      </div>
      {deployment.error || error ? <p className="mt-2 text-xs text-red-700">{error ?? deployment.error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {deployment.status === "ready" && previewUrl ? (
          <>
            <button type="button" className="flex h-8 items-center gap-1 rounded-md bg-white px-2 text-xs text-blue-700" onClick={() => window.open(previewUrl, "_blank")}><ExternalLink className="h-3.5 w-3.5" />打开</button>
            <CopyPreviewButton text={previewUrl} />
          </>
        ) : null}
        {localPreviewUrl && localPreviewUrl !== previewUrl ? (
          <button type="button" className="flex h-8 items-center gap-1 rounded-md bg-white px-2 text-xs text-blue-700" onClick={() => window.open(localPreviewUrl, "_blank")}>本地回退</button>
        ) : null}
        {deployment.sourceDownloadPath ? <a href={deployment.sourceDownloadPath} className="flex h-8 items-center gap-1 rounded-md bg-white px-2 text-xs text-blue-700"><Download className="h-3.5 w-3.5" />源码</a> : null}
        {deployment.containerDownloadPath ? <a href={deployment.containerDownloadPath} className="flex h-8 items-center gap-1 rounded-md bg-white px-2 text-xs text-blue-700"><Download className="h-3.5 w-3.5" />容器包</a> : null}
        <button type="button" disabled={retrying} onClick={() => void retry()} className="flex h-8 items-center gap-1 rounded-md bg-white px-2 text-xs text-blue-700 disabled:opacity-60">
          <RotateCcw className={`h-3.5 w-3.5 ${retrying ? "animate-spin" : ""}`} />重试
        </button>
      </div>
    </div>
  );
}

function DeployCandidates({
  candidates,
  conversationId
}: {
  candidates: Extract<MessagePart, { type: "deploy_candidates" }>["candidates"];
  conversationId: string | null;
}) {
  const [deployingId, setDeployingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handleDeploy = async (artifactId: string) => {
    if (!conversationId) return;
    setDeployingId(artifactId);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactId })
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "部署失败。");
    } catch (deployError) {
      setError(deployError instanceof Error ? deployError.message : "部署失败。");
    } finally {
      setDeployingId(null);
    }
  };
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm">
      <div className="mb-2 font-medium text-blue-900">选择要部署的产物</div>
      <div className="space-y-2">
        {candidates.map((candidate) => (
          <div key={candidate.artifactId} className="flex items-center justify-between rounded-lg border border-blue-100 bg-white px-3 py-2">
            <div>
              <span className="font-medium text-slate-800">{candidate.title}</span>
              <span className="ml-2 text-xs text-slate-500">v{candidate.version}</span>
            </div>
            <button
              type="button"
              disabled={deployingId !== null}
              onClick={() => void handleDeploy(candidate.artifactId)}
              className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {deployingId === candidate.artifactId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              部署
            </button>
          </div>
        ))}
      </div>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}

function CopyPreviewButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="grid h-8 w-8 place-items-center rounded-md bg-white text-blue-700 hover:bg-blue-100"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
      title="复制预览地址"
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
