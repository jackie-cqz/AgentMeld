"use client";

import { Check, Copy, Loader2, RefreshCw, Search, WrapText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { requestJson } from "@/lib/request-json";
import { useAppStore } from "@/stores/app-store";

export function FileTab({ conversationId, filePath }: { conversationId: string; filePath: string }) {
  const revision = useAppStore((state) => state.fileRevisionByConversation[conversationId] ?? 0);
  const [content, setContent] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loadedRevision, setLoadedRevision] = useState(revision);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await requestJson<{ content: string; truncated: boolean }>(
        `/api/conversations/${conversationId}/workspace-files?path=${encodeURIComponent(filePath)}&read=1`
      );
      setContent(data.content);
      setTruncated(data.truncated);
      setLoadedRevision(revision);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "文件读取失败。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void requestJson<{ content: string; truncated: boolean }>(
      `/api/conversations/${conversationId}/workspace-files?path=${encodeURIComponent(filePath)}&read=1`
    ).then((data) => {
      if (!cancelled) {
        setContent(data.content);
        setTruncated(data.truncated);
      }
    }).catch((loadError: unknown) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : "文件读取失败。");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId, filePath]);

  const lines = useMemo(() => content.split("\n"), [content]);
  const matches = useMemo(() => {
    if (!query.trim()) return new Set<number>();
    const normalized = query.toLocaleLowerCase();
    return new Set(lines.flatMap((line, index) =>
      line.toLocaleLowerCase().includes(normalized) ? [index] : []
    ));
  }, [lines, query]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2">
        <div className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600" title={filePath}>{filePath}</div>
        <label className="flex h-8 items-center gap-2 rounded-md border border-slate-200 px-2">
          <Search className="h-3.5 w-3.5 text-slate-400" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="查找" className="w-28 text-xs outline-none" />
        </label>
        <button type="button" onClick={() => setWrap((value) => !value)} className={`grid h-8 w-8 place-items-center rounded-md ${wrap ? "bg-blue-50 text-blue-600" : "text-slate-500 hover:bg-slate-100"}`} title="自动换行">
          <WrapText className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(content);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
          className="grid h-8 w-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100"
          title="复制全文"
        >
          {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
        </button>
        <button type="button" onClick={() => void load()} className="grid h-8 w-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100" title="重新加载">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </header>
      {truncated ? <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">文件过大，当前只显示前一部分内容。</div> : null}
      {revision > loadedRevision ? (
        <div className="flex shrink-0 items-center justify-between border-b border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          Agent 已修改工作区文件，当前内容可能已过期。
          <button type="button" onClick={() => void load()} className="font-medium hover:underline">重新加载</button>
        </div>
      ) : null}
      {error ? (
        <div className="grid flex-1 place-items-center p-6 text-sm text-red-600">
          <div className="text-center">
            <p>{error}</p>
            <button type="button" onClick={() => void load()} className="mt-3 rounded-md border border-red-200 px-3 py-1.5">重试</button>
          </div>
        </div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />读取文件</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-slate-950 py-3 font-mono text-xs leading-6 text-slate-200">
          {lines.map((line, index) => (
            <div key={index} className={`flex min-w-max ${matches.has(index) ? "bg-amber-400/20" : ""}`}>
              <span className="w-14 shrink-0 select-none border-r border-slate-800 pr-3 text-right text-slate-600">{index + 1}</span>
              <code className={`block px-4 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>{line || " "}</code>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
