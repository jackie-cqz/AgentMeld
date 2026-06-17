"use client";

import { ChevronDown, Code2, ExternalLink, Eye, FileText, Image, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useAppStore } from "@/stores/app-store";
import type { Artifact, ArtifactContent } from "@/shared/types";

export function ArtifactPanel() {
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const artifactsByConversation = useAppStore((s) => s.artifactsByConversation);
  const activeArtifactId = useAppStore((s) => s.activeArtifactId);
  const setActiveArtifact = useAppStore((s) => s.setActiveArtifact);
  const [mode, setMode] = useState<"preview" | "source">("preview");

  const artifacts = activeConversationId ? artifactsByConversation[activeConversationId] ?? [] : [];
  const selectedArtifact = activeArtifactId
    ? artifacts.find((a) => a.id === activeArtifactId) ?? artifacts[0] ?? null
    : artifacts[0] ?? null;

  return (
    <aside className="flex h-screen w-[380px] shrink-0 flex-col border-l border-stone-200 bg-white">
      <header className="flex h-16 items-center justify-between border-b border-stone-200 px-5">
        {artifacts.length > 1 ? (
          <div className="relative flex-1 mr-2">
            <select
              className="h-9 w-full rounded-md border border-stone-200 bg-white pl-3 pr-8 text-sm font-medium text-stone-900 appearance-none cursor-pointer"
              value={selectedArtifact?.id ?? ""}
              onChange={(e) => setActiveArtifact(e.target.value || null)}
            >
              {artifacts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title} · v{a.version}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400" />
          </div>
        ) : (
          <div>
            <div className="text-sm font-semibold text-stone-950">
              {selectedArtifact?.title ?? "Artifact Preview"}
            </div>
            <div className="mt-1 text-xs text-stone-500">
              {selectedArtifact ? `${selectedArtifact.type} · v${selectedArtifact.version}` : "等待 Agent 生成产物"}
            </div>
          </div>
        )}
      </header>

      <div className="flex h-12 items-center gap-2 border-b border-stone-200 px-5">
        <button
          className={`flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium transition ${
            mode === "preview" ? "bg-stone-950 text-white" : "text-stone-600 hover:bg-stone-100"
          }`}
          type="button"
          onClick={() => setMode("preview")}
        >
          <Eye className="h-4 w-4" />预览
        </button>
        <button
          className={`flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium transition ${
            mode === "source" ? "bg-stone-950 text-white" : "text-stone-600 hover:bg-stone-100"
          }`}
          type="button"
          onClick={() => setMode("source")}
        >
          <Code2 className="h-4 w-4" />源码
        </button>
      </div>

      <div className="flex-1 overflow-y-auto bg-[#f7f6f2]">
        {selectedArtifact ? (
          <ArtifactPreview artifact={selectedArtifact} mode={mode} />
        ) : (
          <EmptyPreview />
        )}
      </div>

      {selectedArtifact ? (
        <footer className="shrink-0 border-t border-stone-200 px-5 py-3">
          <button
            className="flex w-full items-center gap-2 text-xs text-stone-500 hover:text-stone-900 transition"
            type="button"
            title="版本历史（开发中）"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            版本历史 · {selectedArtifact.version > 1 ? `共 ${selectedArtifact.version} 版` : "初版"}
          </button>
        </footer>
      ) : null}
    </aside>
  );
}

function ArtifactPreview({ artifact, mode }: { artifact: Artifact; mode: "preview" | "source" }) {
  if (mode === "source") {
    return <SourceView artifact={artifact} />;
  }
  if (artifact.type === "web_app") {
    return <WebAppPreview artifactId={artifact.id} />;
  }
  if (artifact.type === "document") {
    return <DocumentPreview artifact={artifact} />;
  }
  if (artifact.type === "image") {
    return <ImagePreview artifact={artifact} />;
  }
  return <SourceView artifact={artifact} />;
}

function WebAppPreview({ artifactId }: { artifactId: string }) {
  const previewUrl = `/api/artifacts/${artifactId}/preview`;
  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium text-stone-700">Web App</span>
        <a href={previewUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-blue-600 hover:underline">
          <ExternalLink className="h-3.5 w-3.5" />新窗口打开
        </a>
      </div>
      <iframe className="min-h-0 flex-1 rounded-md border border-stone-300 bg-white" src={previewUrl} sandbox="allow-scripts" title="Web App Preview" />
    </div>
  );
}

function DocumentPreview({ artifact }: { artifact: Artifact }) {
  const doc = artifact.content as Extract<ArtifactContent, { type: "document" }>;
  const content = doc?.content ?? "";
  return (
    <div className="p-4">
      <div className="rounded-md border border-stone-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-stone-900">
          <FileText className="h-4 w-4" />{artifact.title}
        </div>
        <div className="prose prose-sm max-w-none text-stone-700"><MarkdownRenderer content={content} /></div>
      </div>
    </div>
  );
}

function ImagePreview({ artifact }: { artifact: Artifact }) {
  const img = artifact.content as Extract<ArtifactContent, { type: "image" }>;
  return (
    <div className="p-4">
      <div className="rounded-md border border-stone-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-stone-900">
          <Image className="h-4 w-4" />{artifact.title}
        </div>
        {img?.url ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.url} alt={img.alt ?? artifact.title} className="max-h-96 w-full rounded-md border border-stone-200 object-contain" />
            {img.width && img.height ? <div className="mt-2 text-xs text-stone-500">{String(img.width)} × {String(img.height)}</div> : null}
          </>
        ) : (
          <p className="text-sm text-stone-500">Image URL not available</p>
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
      <div className="rounded-md border border-stone-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-stone-100 px-4 py-2 text-xs text-stone-500">
          <Code2 className="h-3.5 w-3.5" />{artifact.type} · v{artifact.version}
        </div>
        <pre className="overflow-auto p-4 text-sm leading-6 text-stone-700 whitespace-pre-wrap font-mono">{body}</pre>
      </div>
    </div>
  );
}

function EmptyPreview() {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="rounded-md border border-dashed border-stone-300 bg-white p-6 text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-md bg-stone-100 text-stone-500"><FileText className="h-5 w-5" /></div>
        <div className="mt-4 text-sm font-medium text-stone-900">还没有产物</div>
        <p className="mt-2 text-sm leading-6 text-stone-500">Agent 生成文档、代码或 Web App 后会出现在这里。</p>
      </div>
    </div>
  );
}

function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^(#{1,6})/)![1].length;
      const text = line.replace(/^#{1,6}\s+/, "");
      const cls = level <= 2 ? "text-lg font-semibold" : level === 3 ? "text-base font-medium" : "text-sm font-medium";
      if (level === 1) elements.push(<h1 key={i} className={`mt-4 mb-2 first:mt-0 ${cls} text-stone-900`}>{text}</h1>);
      else if (level === 2) elements.push(<h2 key={i} className={`mt-4 mb-2 first:mt-0 ${cls} text-stone-900`}>{text}</h2>);
      else elements.push(<h3 key={i} className={`mt-4 mb-2 first:mt-0 ${cls} text-stone-900`}>{text}</h3>);
      i++; continue;
    }
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s+/, "")); i++; }
      elements.push(<ul key={i} className="my-2 list-disc space-y-1 pl-5 text-stone-700">{items.map((item, idx) => <li key={idx}>{item}</li>)}</ul>);
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, "")); i++; }
      elements.push(<ol key={i} className="my-2 list-decimal space-y-1 pl-5 text-stone-700">{items.map((item, idx) => <li key={idx}>{item}</li>)}</ol>);
      continue;
    }
    if (line.startsWith("```")) {
      const codeLines: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) { codeLines.push(lines[i]); i++; }
      i++;
      elements.push(<pre key={i} className="my-3 overflow-auto rounded-md bg-stone-950 p-3 text-sm text-stone-50"><code>{codeLines.join("\n")}</code></pre>);
      continue;
    }
    const formatted = line.replace(/`([^`]+)`/g, (_m, code) => `<code class="rounded bg-stone-200 px-1 py-0.5 text-sm font-mono text-stone-800">${code}</code>`);
    const bolded = formatted.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    if (line.trim() === "") { elements.push(<div key={i} className="h-3" />); i++; continue; }
    elements.push(<p key={i} className="my-1 leading-7 text-stone-700" dangerouslySetInnerHTML={{ __html: bolded }} />);
    i++;
  }
  return <div>{elements}</div>;
}
