"use client";

import { Loader2, Search } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { useAppStore } from "@/stores/app-store";
import { selectSearchState } from "@/stores/selectors";
import type { SearchHit } from "@/shared/types";
import { Modal } from "@/components/ui/modal";

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
    <Modal open={search.isOpen} onClose={() => setSearchOpen(false)} title="搜索对话" footer={<span className="ui-muted mr-auto">{search.total} 条结果</span>}>
        <div className="flex items-center gap-3 border-b border-[var(--ui-line)] pb-4">
          {search.status === "loading" ? (
            <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
          ) : (
            <Search className="h-5 w-5 text-slate-400" />
          )}
          <input
            ref={inputRef}
            data-autofocus
            aria-label="搜索所有对话"
            value={search.query}
            maxLength={200}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索所有对话中的消息..."
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-slate-400"
          />
        </div>

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

    </Modal>
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
