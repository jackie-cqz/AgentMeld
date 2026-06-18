"use client";

import { ChevronLeft, ChevronRight, Presentation } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { ArtifactContent, PptBlock, PptSlide, PptTheme } from "@/shared/types";

interface ResolvedTheme {
  primary: string;
  background: string;
  surface: string;
  textBody: string;
  textMuted: string;
  divider: string;
  fontHeading: string;
  fontBody: string;
}

export function PptPreview({
  content,
  title
}: {
  content: Extract<ArtifactContent, { type: "ppt" }>;
  title: string;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const slides = content.slides ?? [];
  const theme = useMemo(() => resolveTheme(content.theme), [content.theme]);

  if (slides.length === 0) {
    return (
      <div className="grid min-h-[520px] place-items-center p-6 text-sm text-slate-500">
        这个演示文稿还没有幻灯片。
      </div>
    );
  }

  const selectedIndex = Math.min(activeIndex, slides.length - 1);
  const activeSlide = slides[selectedIndex];
  return (
    <div className="flex min-h-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-slate-800">
          <Presentation className="h-4 w-4 shrink-0" />
          <span className="truncate">{content.title ?? title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            title="上一页"
            disabled={selectedIndex === 0}
            onClick={() => setActiveIndex((current) => Math.max(0, current - 1))}
            className="grid h-8 w-8 place-items-center rounded-md border border-slate-200 bg-white text-slate-600 disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-14 text-center text-xs text-slate-500">
            {selectedIndex + 1} / {slides.length}
          </span>
          <button
            type="button"
            title="下一页"
            disabled={selectedIndex === slides.length - 1}
            onClick={() => setActiveIndex((current) => Math.min(slides.length - 1, current + 1))}
            className="grid h-8 w-8 place-items-center rounded-md border border-slate-200 bg-white text-slate-600 disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <SlideCanvas slide={activeSlide} theme={theme} />

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {slides.map((slide, index) => (
          <button
            key={index}
            type="button"
            onClick={() => setActiveIndex(index)}
            className={`aspect-video overflow-hidden rounded-md border bg-white p-2 text-left transition ${
              selectedIndex === index ? "border-blue-500 ring-2 ring-blue-100" : "border-slate-200 hover:border-slate-300"
            }`}
            title={`第 ${index + 1} 页`}
          >
            <div className="line-clamp-2 text-[10px] font-semibold text-slate-700">
              {slide.title || slide.subtitle || `幻灯片 ${index + 1}`}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function SlideCanvas({ slide, theme }: { slide: PptSlide; theme: ResolvedTheme }) {
  const blocks = slide.blocks?.length
    ? slide.blocks
    : slide.bullets?.length
      ? [{ type: "bullets", items: slide.bullets } satisfies PptBlock]
      : [];

  return (
    <section
      className="aspect-video w-full overflow-hidden rounded-md border border-slate-200 p-[5%] shadow-sm"
      style={{
        background: theme.background,
        color: theme.textBody,
        fontFamily: theme.fontBody
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        {slide.title ? (
          <h2
            className="line-clamp-2 text-2xl font-semibold leading-tight"
            style={{ color: theme.primary, fontFamily: theme.fontHeading }}
          >
            {slide.title}
          </h2>
        ) : null}
        {slide.subtitle ? (
          <p className="mt-2 line-clamp-2 text-sm" style={{ color: theme.textMuted }}>
            {slide.subtitle}
          </p>
        ) : null}
        <div className="mt-4 grid min-h-0 flex-1 content-start gap-3 overflow-hidden">
          {blocks.map((block, index) => (
            <SlideBlock key={index} block={block} theme={theme} />
          ))}
        </div>
      </div>
    </section>
  );
}

function SlideBlock({ block, theme }: { block: PptBlock; theme: ResolvedTheme }): ReactNode {
  if (block.type === "divider") {
    return <div className="h-px w-full" style={{ background: theme.divider }} />;
  }
  if (block.type === "spacer") {
    return <div className="h-3" />;
  }
  if (block.type === "bullets") {
    const items = stringArray(block.items);
    return (
      <ul className="grid list-disc gap-1 pl-5 text-sm leading-5">
        {items.map((item, index) => <li key={index}>{item}</li>)}
      </ul>
    );
  }
  if (block.type === "metric") {
    return (
      <div className="rounded-md p-3" style={{ background: theme.surface }}>
        <div className="text-2xl font-semibold" style={{ color: theme.primary }}>
          {stringValue(block.value) || stringValue(block.text)}
        </div>
        <div className="mt-1 text-xs" style={{ color: theme.textMuted }}>{stringValue(block.label)}</div>
      </div>
    );
  }
  if (block.type === "quote") {
    return (
      <blockquote className="border-l-4 pl-4 text-sm italic leading-6" style={{ borderColor: theme.primary }}>
        {stringValue(block.text) || stringValue(block.quote)}
        {stringValue(block.author) ? (
          <footer className="mt-2 text-xs not-italic" style={{ color: theme.textMuted }}>
            {stringValue(block.author)}
          </footer>
        ) : null}
      </blockquote>
    );
  }
  if (block.type === "timeline") {
    const items = objectArray(block.items);
    return (
      <div className="grid grid-cols-2 gap-2">
        {items.map((item, index) => (
          <div key={index} className="border-l-2 pl-3 text-xs" style={{ borderColor: theme.primary }}>
            <div className="font-semibold">{stringValue(item.title) || stringValue(item.label)}</div>
            <div className="mt-1" style={{ color: theme.textMuted }}>{stringValue(item.text) || stringValue(item.description)}</div>
          </div>
        ))}
      </div>
    );
  }
  if (block.type === "columns") {
    const columns = objectArray(block.columns);
    return (
      <div className="grid grid-cols-2 gap-3">
        {columns.map((column, index) => (
          <div key={index} className="rounded-md p-3 text-xs" style={{ background: theme.surface }}>
            <div className="font-semibold">{stringValue(column.title)}</div>
            <div className="mt-1 leading-5">{stringValue(column.text) || stringArray(column.items).join("\n")}</div>
          </div>
        ))}
      </div>
    );
  }
  if (block.type === "callout") {
    return (
      <div className="rounded-md border p-3 text-sm" style={{ background: theme.surface, borderColor: theme.divider }}>
        <div className="font-semibold">{stringValue(block.title)}</div>
        <div className="mt-1 leading-5">{stringValue(block.text) || stringValue(block.content)}</div>
      </div>
    );
  }

  const text = stringValue(block.text) || stringValue(block.content) || stringValue(block.title);
  if (!text) return null;
  if (block.type === "heading") {
    return <h3 className="text-lg font-semibold" style={{ color: theme.primary, fontFamily: theme.fontHeading }}>{text}</h3>;
  }
  return <p className="text-sm leading-6">{text}</p>;
}

function resolveTheme(theme?: PptTheme): ResolvedTheme {
  return {
    primary: validColor(theme?.primary, "#3157d5"),
    background: validColor(theme?.background, "#ffffff"),
    surface: validColor(theme?.surface, "#eef2ff"),
    textBody: validColor(theme?.textBody, "#172033"),
    textMuted: validColor(theme?.textMuted, "#64748b"),
    divider: validColor(theme?.divider, "#cbd5e1"),
    fontHeading: theme?.fontHeading || "Arial, sans-serif",
    fontBody: theme?.fontBody || "Arial, sans-serif"
  };
}

function validColor(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : [];
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}
