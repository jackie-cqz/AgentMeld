"use client";

import { ArrowLeftRight } from "lucide-react";
import { useMemo, useState } from "react";
import { FileDiffView } from "@/components/file-diff-view";
import type { Artifact } from "@/shared/types";

export function ArtifactVersionCompare({
  versions,
  currentId
}: {
  versions: Artifact[];
  currentId: string;
}) {
  const [oldId, setOldId] = useState(versions.at(-2)?.id ?? versions[0]?.id ?? "");
  const [newId, setNewId] = useState(
    versions.find((version) => version.id === currentId)?.id ?? versions.at(-1)?.id ?? ""
  );
  const oldVersion = versions.find((version) => version.id === oldId);
  const newVersion = versions.find((version) => version.id === newId);
  const webFiles = useMemo(() => {
    if (oldVersion?.content.type !== "web_app" || newVersion?.content.type !== "web_app") return [];
    return Array.from(new Set([
      ...Object.keys(oldVersion.content.files),
      ...Object.keys(newVersion.content.files)
    ])).sort();
  }, [newVersion, oldVersion]);
  const [activeFile, setActiveFile] = useState(webFiles[0] ?? "");
  const selectedFile = webFiles.includes(activeFile) ? activeFile : webFiles[0] ?? "";

  if (versions.length < 2) {
    return <p className="text-sm text-slate-500">至少需要两个版本才能对比。</p>;
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
        <VersionSelect label="原版本" value={oldId} versions={versions} onChange={setOldId} />
        <button
          type="button"
          onClick={() => {
            setOldId(newId);
            setNewId(oldId);
          }}
          className="grid h-9 w-9 place-items-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50"
          title="交换版本"
        >
          <ArrowLeftRight className="h-4 w-4" />
        </button>
        <VersionSelect label="新版本" value={newId} versions={versions} onChange={setNewId} />
      </div>
      {oldVersion && newVersion ? (
        <div className="grid grid-cols-2 gap-3 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
          <span>v{oldVersion.version} · {new Date(oldVersion.createdAt).toLocaleString("zh-CN")}</span>
          <span>v{newVersion.version} · {new Date(newVersion.createdAt).toLocaleString("zh-CN")}</span>
        </div>
      ) : null}
      {oldVersion?.content.type === "document" && newVersion?.content.type === "document" ? (
        <FileDiffView oldContent={oldVersion.content.content} newContent={newVersion.content.content} />
      ) : null}
      {oldVersion?.content.type === "web_app" && newVersion?.content.type === "web_app" ? (
        <>
          <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
            {webFiles.map((fileName) => (
              <button
                key={fileName}
                type="button"
                onClick={() => setActiveFile(fileName)}
                className={`rounded-md border px-2 py-1 font-mono text-xs ${
                  selectedFile === fileName
                    ? "border-blue-300 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-600"
                }`}
              >
                {fileName}
              </button>
            ))}
          </div>
          <FileDiffView
            oldContent={oldVersion.content.files[selectedFile] ?? ""}
            newContent={newVersion.content.files[selectedFile] ?? ""}
          />
        </>
      ) : null}
      {oldVersion && newVersion &&
      oldVersion.content.type !== newVersion.content.type ? (
        <p className="text-sm text-amber-700">不同类型的产物版本不能进行文本对比。</p>
      ) : null}
      {oldVersion && newVersion &&
      oldVersion.content.type === newVersion.content.type &&
      oldVersion.content.type !== "document" &&
      oldVersion.content.type !== "web_app" ? (
        <p className="text-sm text-slate-500">当前仅支持 Document 和 Web App 的确定性文本对比。</p>
      ) : null}
    </div>
  );
}

function VersionSelect({
  label,
  value,
  versions,
  onChange
}: {
  label: string;
  value: string;
  versions: Artifact[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs text-slate-500">
      {label}
      <select
        className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {versions.map((version) => (
          <option key={version.id} value={version.id}>v{version.version} · {version.title}</option>
        ))}
      </select>
    </label>
  );
}
