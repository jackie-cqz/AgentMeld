"use client";

import { Columns2, Rows3 } from "lucide-react";
import { useMemo, useState } from "react";

export interface DiffLine {
  kind: "same" | "added" | "removed";
  oldNumber: number | null;
  newNumber: number | null;
  content: string;
}

export function FileDiffView({ oldContent, newContent }: { oldContent: string | null; newContent: string }) {
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const lines = useMemo(() => buildLineDiff(oldContent ?? "", newContent), [oldContent, newContent]);
  const changedCount = lines.filter((line) => line.kind !== "same").length;

  return (
    <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
        <span className="text-xs text-slate-500">{changedCount} 行变更</span>
        <div className="flex rounded-md border border-slate-200 bg-white p-0.5">
          <button
            type="button"
            className={`grid h-6 w-7 place-items-center rounded ${mode === "unified" ? "bg-slate-100 text-slate-800" : "text-slate-400"}`}
            onClick={() => setMode("unified")}
            title="统一视图"
          >
            <Rows3 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={`grid h-6 w-7 place-items-center rounded ${mode === "split" ? "bg-slate-100 text-slate-800" : "text-slate-400"}`}
            onClick={() => setMode("split")}
            title="并排视图"
          >
            <Columns2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {mode === "unified" ? <UnifiedDiff lines={lines} /> : <SplitDiff lines={lines} />}
    </div>
  );
}

function UnifiedDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="max-h-72 overflow-auto font-mono text-xs">
      {lines.map((line, index) => (
        <div key={`${index}-${line.kind}`} className={`grid grid-cols-[40px_40px_1fr] ${lineClass(line.kind)}`}>
          <span className="border-r border-black/5 px-2 py-1 text-right text-slate-400">{line.oldNumber ?? ""}</span>
          <span className="border-r border-black/5 px-2 py-1 text-right text-slate-400">{line.newNumber ?? ""}</span>
          <pre className="whitespace-pre-wrap break-all px-2 py-1">{prefix(line.kind)}{line.content}</pre>
        </div>
      ))}
    </div>
  );
}

function SplitDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="grid max-h-72 grid-cols-2 overflow-auto font-mono text-xs">
      <div className="border-r border-slate-200">
        {lines.filter((line) => line.kind !== "added").map((line, index) => (
          <pre key={index} className={`min-h-6 whitespace-pre-wrap break-all px-2 py-1 ${lineClass(line.kind)}`}>
            {line.content}
          </pre>
        ))}
      </div>
      <div>
        {lines.filter((line) => line.kind !== "removed").map((line, index) => (
          <pre key={index} className={`min-h-6 whitespace-pre-wrap break-all px-2 py-1 ${lineClass(line.kind)}`}>
            {line.content}
          </pre>
        ))}
      </div>
    </div>
  );
}

export function buildLineDiff(oldContent: string, newContent: string): DiffLine[] {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const matrix = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      matrix[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? matrix[oldIndex + 1][newIndex + 1] + 1
        : Math.max(matrix[oldIndex + 1][newIndex], matrix[oldIndex][newIndex + 1]);
    }
  }

  const result: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      result.push({ kind: "same", oldNumber: oldIndex + 1, newNumber: newIndex + 1, content: oldLines[oldIndex] });
      oldIndex++;
      newIndex++;
    } else if (matrix[oldIndex + 1][newIndex] >= matrix[oldIndex][newIndex + 1]) {
      result.push({ kind: "removed", oldNumber: oldIndex + 1, newNumber: null, content: oldLines[oldIndex] });
      oldIndex++;
    } else {
      result.push({ kind: "added", oldNumber: null, newNumber: newIndex + 1, content: newLines[newIndex] });
      newIndex++;
    }
  }
  while (oldIndex < oldLines.length) {
    result.push({ kind: "removed", oldNumber: oldIndex + 1, newNumber: null, content: oldLines[oldIndex++] });
  }
  while (newIndex < newLines.length) {
    result.push({ kind: "added", oldNumber: null, newNumber: newIndex + 1, content: newLines[newIndex++] });
  }
  return result;
}

function lineClass(kind: DiffLine["kind"]) {
  if (kind === "added") return "bg-emerald-50 text-emerald-900";
  if (kind === "removed") return "bg-red-50 text-red-900";
  return "bg-white text-slate-700";
}

function prefix(kind: DiffLine["kind"]) {
  if (kind === "added") return "+ ";
  if (kind === "removed") return "- ";
  return "  ";
}
