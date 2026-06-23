"use client";

import { Loader2, Search, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { useAppStore } from "@/stores/app-store";
import { selectSearchState } from "@/stores/selectors";
import type { SearchHit } from "@/shared/types";

export function GlobalSearch() {
  const search = useAppStore(selectSearchState);
  const setSearchOpen = useAppStore((state) => state.setSearchOpen);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const runSearch = useAppStore((state) => state.runSearch);
  const jumpToSearchHit = useAppStore((state) => state.jumpToSearchHit);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key === "Escape" && useAppStore.getState().searchState.isOpen) {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setSearchOpen]);

  useEffect(() => {
    if (!search.isOpen) return;
    inputRef.current?.focus();
    const timeout = window.setTimeout(() => {
      void runSearch();
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [runSearch, search.isOpen, search.query]);

  if (!search.isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-slate-950/35 px-4 pt-[10vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setSearchOpen(false);
      }}
    >
      <section className="flex max-h-[72vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 px-4">
          {search.status === "loading" ? (
            <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
          ) : (
            <Search className="h-5 w-5 text-slate-400" />
          )}
          <input
            ref={inputRef}
            value={search.query}
            maxLength={200}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索所有对话中的消息..."
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-slate-400"
          />
          <span className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-400">ESC</span>
          <button
            type="button"
            title="关闭搜索"
            onClick={() => setSearchOpen(false)}
            className="grid h-8 w-8 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {search.query.trim().length < 2 ? (
            <SearchEmpty>输入至少两个字符。支持中文短词、英文前缀和精确短语。</SearchEmpty>
          ) : search.status === "error" ? (
            <SearchEmpty>{search.error ?? "搜索失败。"}</SearchEmpty>
          ) : search.status === "loading" && search.results.length === 0 ? (
            <SearchEmpty>正在搜索...</SearchEmpty>
          ) : search.status === "ready" && search.results.length === 0 ? (
            <SearchEmpty>没有找到匹配消息。</SearchEmpty>
          ) : (
            <div className="space-y-1">
              {search.results.map((hit) => (
                <SearchResultItem
                  key={hit.messageId}
                  hit={hit}
                  query={search.query}
                  onClick={() => jumpToSearchHit(hit)}
                />
              ))}
            </div>
          )}
        </div>

        <footer className="flex h-10 shrink-0 items-center justify-between border-t border-slate-200 bg-slate-50 px-4 text-xs text-slate-500">
          <span>{search.total > 0 ? `${search.total} 条结果` : "全文搜索"}</span>
          <span>{search.mode === "like" ? "短词子串搜索" : "FTS5 全文索引"}</span>
        </footer>
      </section>
    </div>
  );
}

function SearchResultItem({
  hit,
  query,
  onClick
}: {
  hit: SearchHit;
  query: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-md px-3 py-3 text-left transition hover:bg-blue-50 focus:bg-blue-50 focus:outline-none"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 truncate text-sm font-medium text-slate-900">{hit.conversationTitle}</div>
        <time className="shrink-0 text-xs text-slate-400">{formatSearchTime(hit.createdAt)}</time>
      </div>
      <div className="mt-1 text-xs text-slate-500">
        {hit.role === "user" ? "你" : hit.agentName ?? (hit.role === "system" ? "System" : "Agent")}
      </div>
      <p className="mt-1 line-clamp-3 text-sm leading-6 text-slate-600">
        <HighlightedSnippet snippet={hit.snippetHtml} query={query} />
      </p>
    </button>
  );
}

function HighlightedSnippet({ snippet, query }: { snippet: string; query: string }) {
  if (snippet.includes("<mark>")) {
    return snippet.split(/(<mark>.*?<\/mark>)/g).map((part, index) =>
      part.startsWith("<mark>") ? (
        <mark key={index} className="rounded bg-amber-200 px-0.5 text-slate-900">
          {part.replace(/^<mark>|<\/mark>$/g, "")}
        </mark>
      ) : <span key={index}>{part}</span>
    );
  }

  const normalizedQuery = query.trim();
  if (!normalizedQuery) return snippet;
  const index = snippet.toLocaleLowerCase().indexOf(normalizedQuery.toLocaleLowerCase());
  if (index < 0) return snippet;
  return (
    <>
      {snippet.slice(0, index)}
      <mark className="rounded bg-amber-200 px-0.5 text-slate-900">
        {snippet.slice(index, index + normalizedQuery.length)}
      </mark>
      {snippet.slice(index + normalizedQuery.length)}
    </>
  );
}

function SearchEmpty({ children }: { children: ReactNode }) {
  return <div className="grid min-h-48 place-items-center px-6 text-center text-sm text-slate-500">{children}</div>;
}

function formatSearchTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}
