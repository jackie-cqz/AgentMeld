"use client";

import { ChevronDown, Code2, ExternalLink, Eye, FileText, History, Image as ImageIcon, Loader2, Pencil, Save, X } from "lucide-react";
import {
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { useShallow } from "zustand/react/shallow";
import { ArtifactVersionCompare } from "@/components/artifact-version-compare";
import { PptPreview } from "@/components/ppt-preview";
import { useAppStore } from "@/stores/app-store";
import { selectConversationArtifacts, selectSelectedArtifact } from "@/stores/selectors";
import type { Artifact, ArtifactContent } from "@/shared/types";

const MIN_PANEL_WIDTH = 380;
const MAX_PANEL_WIDTH = 960;

export function ArtifactPanel() {
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const artifacts = useAppStore(useShallow((s) => selectConversationArtifacts(s, s.activeConversationId)));
  const activeArtifact = useAppStore(selectSelectedArtifact);
  const setActiveArtifact = useAppStore((s) => s.setActiveArtifact);
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const panelWidth = useAppStore((s) => s.artifactPanelWidth);
  const setPanelWidth = useAppStore((s) => s.setArtifactPanelWidth);
  const [mode, setMode] = useState<"preview" | "source" | "edit">("preview");

  const fallbackArtifact = artifacts.at(-1) ?? null;
  const selectedArtifact = activeArtifact?.conversationId === activeConversationId ? activeArtifact : fallbackArtifact;
  const effectiveMode =
    mode === "edit" && selectedArtifact?.type !== "document" && selectedArtifact?.type !== "web_app"
      ? "preview"
      : mode;

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const maxWidth = Math.min(MAX_PANEL_WIDTH, Math.round(window.innerWidth * 0.72));
      const nextWidth = clamp(startWidth + startX - moveEvent.clientX, MIN_PANEL_WIDTH, maxWidth);
      setPanelWidth(nextWidth);
    };

    const handlePointerUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const maxWidth = Math.min(MAX_PANEL_WIDTH, Math.round(window.innerWidth * 0.72));
    const delta = event.key === "ArrowLeft" ? 24 : -24;
    setPanelWidth((current) => clamp(current + delta, MIN_PANEL_WIDTH, maxWidth));
  };

  return (
    <aside
      className="relative flex h-screen shrink-0 flex-col border-l border-slate-200 bg-white"
      style={{ width: panelWidth, minWidth: MIN_PANEL_WIDTH, maxWidth: MAX_PANEL_WIDTH }}
    >
      <div
        aria-label="调整 Artifact Workspace 宽度"
        aria-orientation="vertical"
        aria-valuemax={MAX_PANEL_WIDTH}
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuenow={panelWidth}
        className="group absolute left-0 top-0 z-20 h-full w-2 -translate-x-1 cursor-col-resize touch-none"
        onKeyDown={handleResizeKeyDown}
        onPointerDown={handleResizeStart}
        role="separator"
        tabIndex={0}
      >
        <div className="mx-auto h-full w-px bg-transparent transition group-hover:bg-[#4264ff]" />
      </div>
      <header className="flex h-[72px] shrink-0 items-center justify-between border-b border-slate-200 px-4">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold text-slate-950">产物库</div>
          <div className="mt-1 text-xs text-slate-500">浏览产物</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ToolbarButton
            title="新窗口打开"
            disabled={selectedArtifact?.type !== "web_app"}
            onClick={() => selectedArtifact?.type === "web_app" ? window.open(getWebAppPreviewUrl(selectedArtifact), "_blank") : null}
          >
            <ExternalLink className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            title="关闭预览"
            onClick={() => {
              setActiveArtifact(null);
              setRightPanelOpen(false);
            }}
          >
            <X className="h-4 w-4" />
          </ToolbarButton>
        </div>
      </header>

      {artifacts.length > 1 ? (
        <div className="flex h-11 shrink-0 items-center border-b border-slate-200 px-4">
          <div className="relative w-full">
            <select
              className="h-8 w-full cursor-pointer appearance-none rounded-lg border border-slate-200 bg-white pl-3 pr-8 text-xs font-medium text-slate-700 outline-none hover:border-slate-300"
              value={selectedArtifact?.id ?? ""}
              onChange={(e) => setActiveArtifact(e.target.value)}
            >
              <option value="" disabled>选择产物</option>
              {artifacts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title} · v{a.version}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        </div>
      ) : null}

      {selectedArtifact ? (
        <div className="flex h-9 shrink-0 items-center border-b border-slate-200 px-4 text-xs text-slate-500">
          {formatArtifactType(selectedArtifact.type)} · v{selectedArtifact.version}
        </div>
      ) : null}

      <div className="flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b border-slate-200 px-3">
        <div className="flex shrink-0 items-center gap-1 rounded-lg bg-slate-100 p-1">
          <button
            className={`flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition ${
              effectiveMode === "preview" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-900"
            }`}
            type="button"
            onClick={() => setMode("preview")}
          >
            <Eye className="h-4 w-4 shrink-0" />预览
          </button>
          <button
            className={`flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition ${
              effectiveMode === "source" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-900"
            }`}
            type="button"
            onClick={() => setMode("source")}
          >
            <Code2 className="h-4 w-4 shrink-0" />源码
          </button>
          {selectedArtifact && (selectedArtifact.type === "document" || selectedArtifact.type === "web_app") ? (
            <button
              className={`flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition ${
                effectiveMode === "edit" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-900"
              }`}
              type="button"
              onClick={() => setMode("edit")}
            >
              <Pencil className="h-4 w-4 shrink-0" />编辑
            </button>
          ) : null}
        </div>
        <VersionHistoryButton artifact={selectedArtifact} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#f4f6fb]">
        {selectedArtifact ? (
          <ArtifactPreview artifact={selectedArtifact} mode={effectiveMode} />
        ) : (
          <EmptyPreview />
        )}
      </div>
    </aside>
  );
}

function ArtifactPreview({ artifact, mode }: { artifact: Artifact; mode: "preview" | "source" | "edit" }) {
  if (mode === "source") {
    return <SourceView artifact={artifact} />;
  }
  if (mode === "edit") {
    return <ArtifactEditor key={artifact.id} artifact={artifact} />;
  }
  if (artifact.type === "web_app") {
    return <WebAppPreview artifact={artifact} />;
  }
  if (artifact.type === "document") {
    return <DocumentPreview artifact={artifact} />;
  }
  if (artifact.type === "image") {
    return <ImagePreview artifact={artifact} />;
  }
  if (artifact.content.type === "ppt") {
    return <PptPreview content={artifact.content} title={artifact.title} />;
  }
  return <SourceView artifact={artifact} />;
}

function ArtifactEditor({ artifact }: { artifact: Artifact }) {
  const applyEvent = useAppStore((state) => state.applyEvent);
  const setActiveArtifact = useAppStore((state) => state.setActiveArtifact);
  const [title, setTitle] = useState(artifact.title);
  const [documentContent, setDocumentContent] = useState(
    artifact.content.type === "document" ? artifact.content.content : ""
  );
  const [files, setFiles] = useState<Record<string, string>>(
    artifact.content.type === "web_app" ? artifact.content.files : {}
  );
  const [activeFile, setActiveFile] = useState(
    artifact.content.type === "web_app"
      ? artifact.content.entry in artifact.content.files
        ? artifact.content.entry
        : Object.keys(artifact.content.files)[0] ?? ""
      : ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDirty =
    title !== artifact.title ||
    (artifact.content.type === "document" && documentContent !== artifact.content.content) ||
    (artifact.content.type === "web_app" && JSON.stringify(files) !== JSON.stringify(artifact.content.files));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const content: ArtifactContent = artifact.content.type === "document"
      ? { ...artifact.content, content: documentContent }
      : artifact.content.type === "web_app"
        ? { ...artifact.content, files }
        : artifact.content;
    try {
      const response = await fetch(`/api/artifacts/${artifact.id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() || artifact.title, content })
      });
      const data = await response.json() as { artifact?: Artifact; error?: string };
      if (!response.ok || !data.artifact) throw new Error(data.error ?? "保存新版本失败。");
      applyEvent({
        type: "artifact.create",
        conversationId: data.artifact.conversationId,
        timestamp: Date.now(),
        artifact: data.artifact
      });
      setActiveArtifact(data.artifact.id);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存新版本失败。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <input
          className="h-9 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium outline-none focus:border-blue-400"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-label="产物标题"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !isDirty}
          className="flex h-9 shrink-0 items-center gap-2 rounded-md bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {isDirty ? `保存为 v${artifact.version + 1}` : "无未保存修改"}
        </button>
      </div>

      {artifact.content.type === "document" ? (
        <textarea
          className="min-h-[520px] flex-1 resize-y rounded-md border border-slate-200 bg-white p-4 font-mono text-sm leading-6 outline-none focus:border-blue-400"
          value={documentContent}
          onChange={(event) => setDocumentContent(event.target.value)}
        />
      ) : null}

      {artifact.content.type === "web_app" ? (
        <div className="flex min-h-[520px] flex-1 overflow-hidden rounded-md border border-slate-200 bg-white">
          <div className="w-44 shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50 p-2">
            {Object.keys(files).map((fileName) => (
              <button
                key={fileName}
                type="button"
                onClick={() => setActiveFile(fileName)}
                className={`mb-1 w-full truncate rounded px-2 py-1.5 text-left font-mono text-xs ${
                  activeFile === fileName ? "bg-blue-100 text-blue-800" : "text-slate-600 hover:bg-slate-100"
                }`}
                title={fileName}
              >
                {fileName}
              </button>
            ))}
          </div>
          <textarea
            className="min-w-0 flex-1 resize-none p-4 font-mono text-xs leading-6 outline-none"
            value={files[activeFile] ?? ""}
            onChange={(event) => setFiles((current) => ({ ...current, [activeFile]: event.target.value }))}
            aria-label={activeFile || "Web App 文件"}
          />
        </div>
      ) : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

function WebAppPreview({ artifact }: { artifact: Artifact }) {
  const previewUrl = getWebAppPreviewUrl(artifact);
  return (
    <div className="flex h-full min-h-[520px] flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <span className="flex gap-1">
            <span className="h-2.5 w-2.5 rounded-full bg-red-300" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
          </span>
          Web App
        </div>
        <a href={previewUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-blue-600 hover:underline">
          <ExternalLink className="h-3.5 w-3.5" />新窗口打开
        </a>
      </div>
      <iframe
        className="min-h-0 flex-1 rounded-xl border border-slate-200 bg-white shadow-sm"
        src={previewUrl}
        sandbox={previewUrl.startsWith("/deployments/") ? "allow-scripts allow-same-origin" : "allow-scripts"}
        title="Web App Preview"
      />
    </div>
  );
}

function getWebAppPreviewUrl(artifact: Artifact) {
  if (artifact.content.type === "web_app" && isDeploymentPreviewPath(artifact.content.deploymentPreviewPath)) {
    return trimTrailingSlash(artifact.content.deploymentPreviewPath);
  }
  return `/api/artifacts/${artifact.id}/preview`;
}

function isDeploymentPreviewPath(value: unknown): value is string {
  return typeof value === "string" && /^\/deployments\/dep_[a-zA-Z0-9_-]+\/?$/.test(value);
}

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function DocumentPreview({ artifact }: { artifact: Artifact }) {
  const doc = artifact.content as Extract<ArtifactContent, { type: "document" }>;
  const content = doc?.content ?? "";
  return (
    <div className="p-4">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-900">
          <FileText className="h-4 w-4" />{artifact.title}
        </div>
        <div className="prose prose-sm max-w-none text-slate-700"><MarkdownRenderer content={content} /></div>
      </div>
    </div>
  );
}

function ImagePreview({ artifact }: { artifact: Artifact }) {
  const img = artifact.content as Extract<ArtifactContent, { type: "image" }>;
  return (
    <div className="p-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-900">
          <ImageIcon className="h-4 w-4" />{artifact.title}
        </div>
        {img?.url ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.url} alt={img.alt ?? artifact.title} className="max-h-96 w-full rounded-lg border border-slate-200 object-contain" />
            {img.width && img.height ? <div className="mt-2 text-xs text-slate-500">{String(img.width)} × {String(img.height)}</div> : null}
          </>
        ) : (
          <p className="text-sm text-slate-500">Image URL not available</p>
        )}
      </div>
    </div>
  );
}

function SourceView({ artifact }: { artifact: Artifact }) {
  const body = useMemo(() => {
    if (artifact.content.type === "document") return (artifact.content as Extract<ArtifactContent, { type: "document" }>).content ?? "";
    if (artifact.content.type === "web_app") {
      const wa = artifact.content as Extract<ArtifactContent, { type: "web_app" }>;
      if (wa.files && typeof wa.files === "object") {
        return Object.entries(wa.files).map(([n, s]) => `// ${n}\n${String(s)}`).join("\n\n");
      }
    }
    return JSON.stringify(artifact.content, null, 2);
  }, [artifact.content]);
  return (
    <div className="p-4">
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
          <Code2 className="h-3.5 w-3.5" />{artifact.type} · v{artifact.version}
        </div>
        <pre className="overflow-auto p-4 font-mono text-sm leading-6 text-slate-700 whitespace-pre-wrap">{body}</pre>
      </div>
    </div>
  );
}

function EmptyPreview() {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-lg bg-slate-100 text-slate-500"><FileText className="h-5 w-5" /></div>
        <div className="mt-4 text-sm font-medium text-slate-900">还没有选择产物</div>
        <p className="mt-2 text-sm leading-6 text-slate-500">点击消息里的产物引用，或从产物库选择一个文档、代码或 Web App。</p>
      </div>
    </div>
  );
}

function ToolbarButton({ children, title, onClick, disabled }: { children: ReactNode; title: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-950"
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function formatArtifactType(type: Artifact["type"]) {
  if (type === "web_app") return "Web App";
  if (type === "document") return "Document";
  if (type === "image") return "Image";
  return type;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: ReactNode[] = [];
  let i = 0;
  let kid = 0; // Separate key counter — never shared with line index i
  while (i < lines.length) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^(#{1,6})/)![1].length;
      const text = line.replace(/^#{1,6}\s+/, "");
      const cls = level <= 2 ? "text-lg font-semibold" : level === 3 ? "text-base font-medium" : "text-sm font-medium";
      if (level === 1) elements.push(<h1 key={kid} className={`mt-4 mb-2 first:mt-0 ${cls} text-stone-900`}>{text}</h1>);
      else if (level === 2) elements.push(<h2 key={kid} className={`mt-4 mb-2 first:mt-0 ${cls} text-stone-900`}>{text}</h2>);
      else elements.push(<h3 key={kid} className={`mt-4 mb-2 first:mt-0 ${cls} text-stone-900`}>{text}</h3>);
      i++; kid++; continue;
    }
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s+/, "")); i++; }
      elements.push(<ul key={kid} className="my-2 list-disc space-y-1 pl-5 text-stone-700">{items.map((item, idx) => <li key={idx}>{item}</li>)}</ul>);
      kid++; continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, "")); i++; }
      elements.push(<ol key={kid} className="my-2 list-decimal space-y-1 pl-5 text-stone-700">{items.map((item, idx) => <li key={idx}>{item}</li>)}</ol>);
      kid++; continue;
    }
    if (line.startsWith("```")) {
      const codeLines: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) { codeLines.push(lines[i]); i++; }
      i++;
      elements.push(<pre key={kid} className="my-3 overflow-auto rounded-md bg-stone-950 p-3 text-sm text-stone-50"><code>{codeLines.join("\n")}</code></pre>);
      kid++; continue;
    }
    const formatted = line.replace(/`([^`]+)`/g, (_m, code) => `<code class="rounded bg-stone-200 px-1 py-0.5 text-sm font-mono text-stone-800">${code}</code>`);
    const bolded = formatted.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    if (line.trim() === "") { elements.push(<div key={kid} className="h-3" />); i++; kid++; continue; }
    elements.push(<p key={kid} className="my-1 leading-7 text-stone-700" dangerouslySetInnerHTML={{ __html: bolded }} />);
    i++; kid++;
  }
  return <div>{elements}</div>;
}

function VersionHistoryButton({ artifact }: { artifact: Artifact | null }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"versions" | "compare">("versions");
  const [versions, setVersions] = useState<Artifact[]>([]);
  const [latestId, setLatestId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setActiveArtifact = useAppStore((s) => s.setActiveArtifact);

  const load = () => {
    if (!artifact) return;
    setLoading(true);
    setError(null);
    fetch("/api/artifacts/" + artifact.id + "/versions")
      .then(async (response) => {
        const data = await response.json() as {
          versions?: Artifact[];
          latestId?: string;
          error?: string;
        };
        if (!response.ok) throw new Error(data.error ?? "版本加载失败。");
        setVersions(data.versions ?? []);
        setLatestId(data.latestId ?? null);
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : "版本加载失败。");
      })
      .finally(() => setLoading(false));
    setTab("versions");
    setOpen(true);
  };

  return (
    <>
      <button
        className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
        type="button"
        onClick={load}
        disabled={!artifact}
        title="版本历史"
      >
        <History className="h-4 w-4 shrink-0" />
        版本
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/20" onClick={() => setOpen(false)}>
          <div className="w-[min(760px,calc(100vw-32px))] rounded-lg border border-slate-200 bg-white p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">版本历史</h3>
              <button type="button" title="关闭" onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
            </div>
            <div className="mb-3 flex border-b border-slate-200">
              <button
                type="button"
                onClick={() => setTab("versions")}
                className={`border-b-2 px-3 py-2 text-sm ${tab === "versions" ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500"}`}
              >
                版本
              </button>
              <button
                type="button"
                onClick={() => setTab("compare")}
                disabled={versions.length < 2}
                className={`border-b-2 px-3 py-2 text-sm disabled:opacity-40 ${tab === "compare" ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500"}`}
              >
                对比
              </button>
            </div>
            {loading ? (
              <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />加载版本...</p>
            ) : error ? (
              <p className="text-sm text-red-600">{error}</p>
            ) : tab === "compare" && artifact ? (
              <ArtifactVersionCompare versions={versions} currentId={artifact.id} />
            ) : (
              <div className="max-h-[55vh] space-y-2 overflow-y-auto">
                {versions.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => { setActiveArtifact(v.id); setOpen(false); }}
                    className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left hover:bg-slate-50 ${
                      v.id === artifact?.id ? "border-blue-300 bg-blue-50" : "border-slate-200"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-900">{v.title}</span>
                      <span className="mt-0.5 block text-xs text-slate-400">{new Date(v.createdAt).toLocaleString()}</span>
                    </span>
                    <span className="ml-3 flex shrink-0 items-center gap-1 text-xs">
                      {v.id === artifact?.id ? <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700">当前</span> : null}
                      {v.id === latestId ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700">最新</span> : null}
                      <span className="text-slate-500">v{v.version}</span>
                    </span>
                  </button>
                ))}
                {versions.length === 0 ? <p className="text-sm text-slate-500">没有可用版本。</p> : null}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
