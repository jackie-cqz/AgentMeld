"use client";

import { ExternalLink, FileText, Globe, Image, Trash2 } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import type { Artifact, ArtifactContent } from "@/shared/types";

export function ArtifactLibrary() {
  const artifactsByConversation = useAppStore((s) => s.artifactsByConversation);
  const conversations = useAppStore((s) => s.conversations);
  const setActiveConversation = useAppStore((s) => s.setActiveConversation);
  const setActiveArtifact = useAppStore((s) => s.setActiveArtifact);

  // Flatten all artifacts across conversations
  const allArtifacts: Array<{ artifact: Artifact; conversationTitle: string }> = [];
  for (const [convId, arts] of Object.entries(artifactsByConversation)) {
    const conv = conversations[convId];
    for (const art of arts) {
      allArtifacts.push({
        artifact: art,
        conversationTitle: conv?.title ?? convId
      });
    }
  }
  allArtifacts.sort((a, b) => b.artifact.updatedAt - a.artifact.updatedAt);

  const handleSelect = (item: typeof allArtifacts[0]) => {
    // Find which conversation this artifact belongs to
    for (const [convId, arts] of Object.entries(artifactsByConversation)) {
      if (arts.some((a) => a.id === item.artifact.id)) {
        setActiveConversation(convId);
        setActiveArtifact(item.artifact.id);
        break;
      }
    }
  };

  const handleDelete = async (artifactId: string) => {
    await fetch(`/api/artifacts/${artifactId}`, { method: "DELETE" });
  };

  const typeIcon = (type: string) => {
    if (type === "web_app") return <Globe className="h-4 w-4 text-blue-500" />;
    if (type === "image") return <Image className="h-4 w-4 text-purple-500" />;
    return <FileText className="h-4 w-4 text-emerald-500" />;
  };

  if (allArtifacts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-stone-500">
        <div className="text-center">
          <FileText className="mx-auto h-8 w-8 text-stone-300" />
          <p className="mt-3">暂无产物</p>
          <p className="mt-1 text-xs">Agent 生成的文档、网页和图片会出现在这里</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-5 py-4 border-b border-stone-200">
        <h2 className="text-sm font-semibold text-stone-950">产物库</h2>
        <p className="mt-0.5 text-xs text-stone-500">{allArtifacts.length} 个产物</p>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {allArtifacts.map(({ artifact, conversationTitle }) => (
          <div
            key={artifact.id}
            onClick={() => handleSelect({ artifact, conversationTitle })}
            className="flex w-full cursor-pointer items-start gap-3 rounded-md border border-stone-200 bg-white px-3 py-3 text-left hover:border-stone-300 transition"
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter") handleSelect({ artifact, conversationTitle }); }}
          >
            <div className="mt-0.5">{typeIcon(artifact.type)}</div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-stone-900 truncate">{artifact.title}</div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-stone-500">
                <span className="rounded bg-stone-100 px-1 py-0.5">{artifact.type}</span>
                <span>v{artifact.version}</span>
              </div>
              <div className="mt-1 text-xs text-stone-400 truncate">{conversationTitle}</div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(artifact.id);
              }}
              className="grid h-7 w-7 shrink-0 place-items-center rounded text-stone-400 hover:bg-red-50 hover:text-red-600"
              title="删除"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
