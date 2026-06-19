"use client";

import { useState, useCallback, useEffect } from "react";
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, Loader2, X } from "lucide-react";
import { useAppStore } from "@/stores/app-store";

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
}

interface Props {
  conversationId: string;
  darkMode?: boolean;
  onClose: () => void;
}

export function WorkspaceFileBrowser({ conversationId, darkMode, onClose }: Props) {
  const panelWidth = useAppStore((s) => s.artifactPanelWidth);
  const MIN_W = 320;
  const MAX_W = 960;

  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirContents, setDirContents] = useState<Map<string, FileEntry[]>>(new Map());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);

  const loadDir = useCallback(async (dirPath: string) => {
    try {
      const res = await fetch(`/api/conversations/${conversationId}/workspace-files?path=${encodeURIComponent(dirPath || ".")}`);
      if (!res.ok) throw new Error("Failed to list files");
      const data = await res.json() as { entries: FileEntry[] };
      if (dirPath === ".") {
        setEntries(data.entries);
      } else {
        setDirContents((prev) => new Map(prev).set(dirPath, data.entries));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [conversationId]);

  useEffect(() => {
    setLoading(true);
    loadDir(".").finally(() => setLoading(false));
  }, [loadDir]);

  const toggleDir = async (dirName: string) => {
    const isExpanded = expandedDirs.has(dirName);
    if (isExpanded) {
      setExpandedDirs((prev) => { const next = new Set(prev); next.delete(dirName); return next; });
    } else {
      setExpandedDirs((prev) => new Set(prev).add(dirName));
      if (!dirContents.has(dirName)) {
        await loadDir(dirName);
      }
    }
  };

  const openFile = async (filePath: string) => {
    setSelectedFile(filePath);
    setContentLoading(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/workspace-files?path=${encodeURIComponent(filePath)}&read=1`);
      if (!res.ok) throw new Error("Failed to read file");
      const data = await res.json() as { content: string; truncated: boolean };
      setFileContent(data.content);
    } catch (err) {
      setFileContent(`读取失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
    setContentLoading(false);
  };

  const bg = darkMode ? "bg-slate-800 border-slate-700" : "bg-white border-slate-200";
  const muted = darkMode ? "text-slate-400" : "text-slate-500";
  const textMain = darkMode ? "text-slate-100" : "text-slate-800";

  return (
    <aside
      className={`relative flex h-screen shrink-0 flex-col border-l ${bg}`}
      style={{ width: panelWidth, minWidth: MIN_W, maxWidth: MAX_W }}
    >
      <header className={`flex h-[72px] shrink-0 items-center justify-between border-b border-slate-200 px-4`}>
        <div className="min-w-0">
          <div className={`truncate text-base font-semibold ${textMain}`}>工作区文件</div>
          <div className={`mt-1 text-xs ${muted}`}>浏览 workspace 目录</div>
        </div>
        <button onClick={onClose} className={`grid h-8 w-8 place-items-center rounded-md ${muted} hover:bg-slate-100`}>
          <X className="h-5 w-5" />
        </button>
      </header>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-8 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载中...
          </div>
        ) : error ? (
          <div className="px-4 py-8 text-sm text-red-500">{error}</div>
        ) : entries.length === 0 ? (
          <div className={`px-4 py-8 text-sm ${muted}`}>工作区为空</div>
        ) : (
          <div className="py-2">
            {entries.map((entry) => (
              <FileTreeItem
                key={entry.name}
                entry={entry}
                path={entry.name}
                depth={0}
                expanded={expandedDirs}
                dirContents={dirContents}
                selectedFile={selectedFile}
                onToggleDir={toggleDir}
                onOpenFile={openFile}
                darkMode={darkMode}
              />
            ))}
          </div>
        )}
      </div>

      {/* File content preview */}
      {selectedFile ? (
        <div className="h-1/2 border-t overflow-y-auto">
          <div className={`sticky top-0 flex items-center justify-between border-b px-3 py-2 text-xs font-mono ${darkMode ? "bg-slate-700 text-slate-300" : "bg-slate-100 text-slate-600"}`}>
            {selectedFile}
            {contentLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          </div>
          <pre className={`p-3 text-xs font-mono whitespace-pre-wrap ${darkMode ? "bg-slate-900 text-slate-300" : "bg-slate-50 text-slate-800"}`}>
            {fileContent ?? "加载中..."}
          </pre>
        </div>
      ) : null}
    </aside>
  );
}

function FileTreeItem({
  entry, path, depth, expanded, dirContents, selectedFile, onToggleDir, onOpenFile, darkMode
}: {
  entry: FileEntry; path: string; depth: number;
  expanded: Set<string>; dirContents: Map<string, FileEntry[]>;
  selectedFile: string | null; onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void; darkMode?: boolean;
}) {
  const isDir = entry.type === "directory";
  const isExpanded = expanded.has(path);
  const children = dirContents.get(path);
  const isSelected = selectedFile === path;
  const hoverBg = darkMode ? "hover:bg-slate-700" : "hover:bg-slate-100";
  const selectedBg = darkMode ? "bg-slate-700" : "bg-slate-100";

  return (
    <>
      <button
        className={`flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs ${isSelected ? selectedBg : ""} ${hoverBg}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => isDir ? onToggleDir(path) : onOpenFile(path)}
      >
        {isDir ? (
          isExpanded ? <ChevronDown className="h-3 w-3 shrink-0 text-slate-400" /> : <ChevronRight className="h-3 w-3 shrink-0 text-slate-400" />
        ) : <span className="w-3 shrink-0" />}
        {isDir ? (
          isExpanded ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        ) : (
          <File className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        )}
        <span className={`truncate ${darkMode ? "text-slate-300" : "text-slate-700"}`}>{entry.name}</span>
      </button>
      {isDir && isExpanded && children ? (
        children.map((child) => (
          <FileTreeItem
            key={child.name} entry={child} path={`${path}/${child.name}`}
            depth={depth + 1} expanded={expanded} dirContents={dirContents}
            selectedFile={selectedFile} onToggleDir={onToggleDir} onOpenFile={onOpenFile} darkMode={darkMode}
          />
        ))
      ) : null}
    </>
  );
}
