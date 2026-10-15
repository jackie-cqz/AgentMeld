import { artifactFileName } from "@/server/channels/feishu/file-name";
import type { PptBlock, PptSlide, PptTheme } from "@/shared/types";

/**
 * A ppt artifact, as one file a chat member can open.
 *
 * The artifact is a structure — slides, blocks, a theme — not a file, which is
 * why the channel refused it. A self-contained HTML deck is the rendering that
 * needs nothing else: no CDN, no fonts to fetch, no server. It opens from the
 * download, prints to PDF if a real deck is wanted, and keeps the structure the
 * web preview already shows.
 *
 * Two things this deliberately does NOT do:
 *
 * - It is not a .pptx. Writing OOXML by hand means shipping a slide master,
 *   layouts and theme XML that no test here could honestly verify; a broken
 *   .pptx that PowerPoint refuses to open is worse than an HTML deck that
 *   always opens.
 * - It does not claim the client renders it well. That needs a human in a real
 *   room, and the operations guide says so.
 *
 * Every piece of text is escaped on the way in, because the content comes from
 * a model: a slide title containing markup must be a slide title.
 */

export const MAX_DECK_SLIDES = 200;

const DEFAULT_THEME: Required<Pick<PptTheme, "primary" | "background" | "surface" | "textBody" | "textMuted">> = {
  primary: "#1f2937",
  background: "#ffffff",
  surface: "#f5f5f4",
  textBody: "#292524",
  textMuted: "#78716c",
};

export function renderDeckHtml(content: {
  title?: string;
  theme?: PptTheme;
  slides?: PptSlide[];
}): { ok: true; html: string } | { ok: false; reason: string } {
  const slides = content.slides;
  if (!Array.isArray(slides) || slides.length === 0) {
    return { ok: false, reason: "the deck has no slides" };
  }
  if (slides.length > MAX_DECK_SLIDES) {
    return { ok: false, reason: `the deck has ${slides.length} slides, over the ${MAX_DECK_SLIDES} limit` };
  }

  const theme = resolveTheme(content.theme);
  const deckTitle = escapeHtml(asText(content.title) || "演示文稿");

  const rendered = slides
    .map((slide, index) => renderSlide(slide, index, theme))
    .join("\n");

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${deckTitle}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: ${theme.background}; color: ${theme.textBody};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .deck { display: block; }
  .slide { display: none; padding: 48px 56px; min-height: 100vh; }
  .slide.is-active { display: block; }
  /* Without JS the pager cannot run, so every slide is shown instead. */
  .no-js .slide { display: block; }
  .slide h1 { font-size: 34px; margin: 0 0 8px; color: ${theme.primary}; }
  .slide h2 { font-size: 26px; margin: 0 0 6px; color: ${theme.primary}; }
  .subtitle { color: ${theme.textMuted}; margin: 0 0 24px; font-size: 16px; }
  .blocks { display: grid; gap: 14px; margin-top: 12px; }
  ul.bullets { margin: 0; padding-left: 22px; line-height: 1.7; }
  .metric { background: ${theme.surface}; border-radius: 8px; padding: 14px 16px; }
  .metric .value { font-size: 30px; font-weight: 600; color: ${theme.primary}; }
  .metric .label { font-size: 13px; color: ${theme.textMuted}; margin-top: 4px; }
  blockquote { margin: 0; border-left: 4px solid ${theme.primary}; padding-left: 16px; font-style: italic; line-height: 1.7; }
  blockquote footer { font-style: normal; font-size: 13px; color: ${theme.textMuted}; margin-top: 8px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .card { background: ${theme.surface}; border-radius: 8px; padding: 12px 14px; font-size: 14px; line-height: 1.6; }
  .card .title { font-weight: 600; margin-bottom: 4px; }
  .callout { border: 1px solid ${theme.surface}; background: ${theme.surface}; border-radius: 8px; padding: 12px 14px; }
  .divider { height: 1px; background: ${theme.surface}; }
  .notes { display: none; margin-top: 28px; padding: 12px 14px; background: ${theme.surface};
    border-radius: 8px; font-size: 13px; color: ${theme.textMuted}; }
  body.show-notes .notes { display: block; }
  .hud { position: fixed; right: 16px; bottom: 14px; font-size: 12px; color: ${theme.textMuted};
    background: ${theme.background}; padding: 4px 8px; border-radius: 999px; }
  @media print {
    .slide { display: block; page-break-after: always; min-height: auto; }
    .hud { display: none; }
  }
</style>
</head>
<body class="no-js">
<div class="deck">
${rendered}
</div>
<div class="hud"><span id="position">1</span> / ${slides.length} · ← → 翻页 · N 备注</div>
<script>
(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var index = 0;
  function show(next) {
    index = Math.max(0, Math.min(slides.length - 1, next));
    slides.forEach(function (slide, i) { slide.classList.toggle('is-active', i === index); });
    var position = document.getElementById('position');
    if (position) position.textContent = String(index + 1);
  }
  document.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') show(index + 1);
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') show(index - 1);
    if (event.key === 'n' || event.key === 'N') document.body.classList.toggle('show-notes');
  });
  document.addEventListener('click', function (event) {
    if (event.target && event.target.closest && event.target.closest('.notes')) return;
    show(index + 1);
  });
  show(0);
  // Removed LAST, once the pager is actually running: taken off at the top, any
  // later throw would leave a deck that is already collapsed to one slide with
  // nothing to page it. This way every failure mode falls back to "all slides
  // visible".
  document.body.classList.remove('no-js');
})();
</script>
</body>
</html>`;

  return { ok: true, html };
}

export function deckFileName(title: string): string {
  // Shared with the web_app naming: a single-pass strip left "设计稿v2.0",
  // whose ".0" safeFileName then read as the extension, so the delivered deck
  // had none at all.
  return artifactFileName(title, "deck", ".html");
}

function renderSlide(slide: PptSlide, index: number, theme: ResolvedTheme): string {
  const blocks = Array.isArray(slide?.blocks) && slide.blocks.length > 0
    ? slide.blocks
    : Array.isArray(slide?.bullets) && slide.bullets.length > 0
      ? [{ type: "bullets", items: slide.bullets } as PptBlock]
      : [];

  const title = asText(slide?.title);
  const subtitle = asText(slide?.subtitle);
  const body = blocks.map((block) => renderBlock(block, theme)).filter(Boolean).join("\n");
  const notes = asText(slide?.notes);

  return `<section class="slide${index === 0 ? " is-active" : ""}">
${title ? `<h1>${escapeHtml(title)}</h1>` : ""}
${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ""}
<div class="blocks">
${body}
</div>
${notes ? `<aside class="notes">${escapeHtml(notes)}</aside>` : ""}
</section>`;
}

function renderBlock(block: PptBlock, theme: ResolvedTheme): string {
  // `write_artifact` validates only that `slides` is an array, so a model can
  // emit {"blocks":[null]}. The contract here is "HTML or a reason", never a
  // throw: a throw is swallowed by the subscriber and leaves no skip reason at
  // all, so nothing is logged and nothing is retried.
  if (!block || typeof block !== "object") return "";
  const type = block?.type;
  if (type === "divider") return `<div class="divider"></div>`;
  if (type === "spacer") return `<div style="height:12px"></div>`;

  if (type === "bullets") {
    const items = textArray(block.items);
    if (items.length === 0) return "";
    return `<ul class="bullets">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  }

  if (type === "metric") {
    const value = asText(block.value) || asText(block.text);
    const label = asText(block.label);
    if (!value && !label) return "";
    return `<div class="metric">
${value ? `<div class="value">${escapeHtml(value)}</div>` : ""}
${label ? `<div class="label">${escapeHtml(label)}</div>` : ""}
</div>`;
  }

  if (type === "quote") {
    const text = asText(block.text) || asText(block.quote);
    const author = asText(block.author);
    if (!text) return "";
    return `<blockquote>${escapeHtml(text)}${author ? `<footer>${escapeHtml(author)}</footer>` : ""}</blockquote>`;
  }

  if (type === "timeline") {
    const items = objectArray(block.items);
    if (items.length === 0) return "";
    return `<div class="grid2">${items.map((item) => {
      const itemTitle = asText(item.title) || asText(item.label);
      const itemText = asText(item.text) || asText(item.description);
      return `<div class="card" style="border-left:3px solid ${theme.primary}">
${itemTitle ? `<div class="title">${escapeHtml(itemTitle)}</div>` : ""}
${itemText ? `<div>${escapeHtml(itemText)}</div>` : ""}
</div>`;
    }).join("")}</div>`;
  }

  if (type === "columns") {
    const columns = objectArray(block.columns);
    if (columns.length === 0) return "";
    return `<div class="grid2">${columns.map((column) => {
      const columnTitle = asText(column.title);
      const columnText = asText(column.text) || textArray(column.items).join(" · ");
      return `<div class="card">
${columnTitle ? `<div class="title">${escapeHtml(columnTitle)}</div>` : ""}
${columnText ? `<div>${escapeHtml(columnText)}</div>` : ""}
</div>`;
    }).join("")}</div>`;
  }

  if (type === "callout") {
    const calloutTitle = asText(block.title);
    const calloutText = asText(block.text) || asText(block.content);
    if (!calloutTitle && !calloutText) return "";
    return `<div class="callout">
${calloutTitle ? `<div class="title">${escapeHtml(calloutTitle)}</div>` : ""}
${calloutText ? `<div>${escapeHtml(calloutText)}</div>` : ""}
</div>`;
  }

  const text = asText(block.text) || asText(block.content) || asText(block.title);
  if (!text) return "";
  if (type === "heading") return `<h2>${escapeHtml(text)}</h2>`;
  return `<p>${escapeHtml(text)}</p>`;
}

interface ResolvedTheme {
  primary: string;
  background: string;
  surface: string;
  textBody: string;
  textMuted: string;
}

/**
 * Theme colours go into a style attribute, so only literal colours are
 * accepted. Anything else — `url(...)`, `red; background: url(...)`, an
 * `expression()` — falls back to the default rather than being trusted.
 */
function resolveTheme(theme?: PptTheme): ResolvedTheme {
  return {
    primary: safeColor(theme?.primary, DEFAULT_THEME.primary),
    background: safeColor(theme?.background, DEFAULT_THEME.background),
    surface: safeColor(theme?.surface, DEFAULT_THEME.surface),
    textBody: safeColor(theme?.textBody, DEFAULT_THEME.textBody),
    textMuted: safeColor(theme?.textMuted, DEFAULT_THEME.textMuted)
  };
}

function safeColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return /^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : fallback;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
