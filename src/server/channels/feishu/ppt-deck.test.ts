import { describe, expect, it } from "vitest";
import { MAX_DECK_SLIDES, deckFileName, renderDeckHtml } from "@/server/channels/feishu/ppt-deck";
import { artifactFileFor } from "@/server/channels/feishu/artifact-delivery";
import type { Artifact } from "@/shared/types";

/**
 * The deck renderer turns model-authored structure into a document a browser
 * will execute. That means every string is untrusted markup, and the theme
 * colours land inside a style attribute — both are the kind of "faithful
 * rendering" that is only faithful if it cannot be turned into code.
 */

const SLIDES = [
  { title: "封面", subtitle: "副标题", layout: "title" as const },
  {
    title: "要点",
    bullets: ["第一点", "第二点"],
    notes: "讲稿：这里展开"
  },
  {
    title: "数据",
    blocks: [
      { type: "metric" as const, value: "42%", label: "转化率" },
      { type: "quote" as const, text: "引用的话", author: "某人" },
      { type: "callout" as const, title: "注意", text: "边界条件" }
    ]
  }
];

function pptArtifact(content: Record<string, unknown>): Artifact {
  return {
    id: "art_ppt",
    conversationId: "conv_1",
    title: "季度汇报",
    type: "ppt",
    content,
    createdByAgentId: "ag_1",
    createdAt: 1,
    updatedAt: 1
  } as unknown as Artifact;
}

describe("rendering a deck", () => {
  it("renders every slide and block it was given", () => {
    const result = renderDeckHtml({ title: "季度汇报", slides: SLIDES });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const expected of ["封面", "副标题", "要点", "第一点", "第二点", "42%", "转化率", "引用的话", "某人", "边界条件"]) {
      expect(result.html).toContain(expected);
    }
    expect(result.html.match(/class="slide/g)).toHaveLength(3);
  });

  it("keeps speaker notes out of the visible deck", () => {
    const result = renderDeckHtml({ slides: SLIDES });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('class="notes"');
    // Hidden by default, revealed by the notes toggle.
    expect(result.html).toContain(".slide.is-active");
    expect(result.html).toContain("body.show-notes .notes { display: block; }");
    // Hidden by default, and revealed only by the class: the earlier version of
    // this test asserted neither, so flipping the default stayed green.
    expect(result.html).toContain(".notes { display: none;");
  });

  it("escapes markup everywhere text can come from", () => {
    const result = renderDeckHtml({
      title: '<script>alert("title")</script>',
      slides: [
        {
          title: "<img src=x onerror=alert(1)>",
          subtitle: "\"><script>bad()</script>",
          notes: "</aside><script>notes()</script>",
          blocks: [
            { type: "metric", value: "<svg onload=alert(2)>", label: "&label" },
            { type: "quote", text: "<iframe src='x'>", author: "<i>a</i>" },
            { type: "columns", columns: [{ title: "<u>t</u>", text: "<em>x</em>" }] },
            { type: "timeline", items: [{ title: "<h1>t</h1>", text: "<p>x</p>" }] },
            { type: "callout", title: "<style>*{}</style>", text: "<script>y</script>" },
            { type: "heading", text: "<h1>head</h1>" }
          ]
        },
        // Bullets are the fallback rendering for a slide with no blocks, so
        // they need a slide of their own to be exercised at all.
        { title: "bullets", bullets: ["<b>bold?</b>"] }
      ]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No tag from the content survives as a tag.
    // No tag survives as a tag. (The dangerous-looking text IS present, escaped
    // — asserting on substrings like "onerror=" would flag the escaping.)
    expect(result.html).not.toContain("<script>alert");
    expect(result.html).not.toContain("<img");
    expect(result.html).not.toContain("<u>");
    expect(result.html).not.toContain("<em>");
    expect(result.html).not.toContain("<h1>t</h1>");
    expect(result.html).not.toContain("<iframe");
    expect(result.html).not.toContain("<svg");
    expect(result.html).not.toContain("<style>*{}</style>");
    expect(result.html).toContain("&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;");
    expect(result.html).toContain("&amp;label");
    // The fields a review found were fed payloads here but never asserted on:
    // removing escapeHtml from any of them used to leave this test green.
    expect(result.html).not.toContain("<b>bold?</b>");
    expect(result.html).not.toContain("<script>bad()</script>");
    expect(result.html).not.toContain("<script>notes()");
    expect(result.html).not.toContain("<i>a</i>");
    expect(result.html).not.toContain("<h1>head</h1>");
    expect(result.html).toContain("&lt;b&gt;bold?&lt;/b&gt;");
    expect(result.html).toContain("&lt;i&gt;a&lt;/i&gt;");
    // The heading branch specifically: dropping it still renders the text via
    // the default paragraph branch, so absence assertions cannot see it.
    expect(result.html).toContain("<h2>&lt;h1&gt;head&lt;/h1&gt;</h2>");
  });

  it("only accepts literal colours from the theme", () => {
    const result = renderDeckHtml({
      slides: [{ title: "x" }],
      theme: {
        primary: "red; background: url(https://evil.example/pixel)",
        background: "#fff",
        surface: "url(https://evil.example/x)",
        textBody: "#123456",
        textMuted: "expression(alert(1))"
      } as never
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).not.toContain("evil.example");
    expect(result.html).not.toContain("expression(");
    // The valid ones are kept as given.
    expect(result.html).toContain("#fff");
    expect(result.html).toContain("#123456");
    // Every colour that reached the CSS is a literal hex, and the injected text
    // did not become CSS: asserting only "no evil.example" was satisfied by a
    // whitelist weakened to "anything without url( or expression(".
    for (const colour of result.html.match(/(?:color|background|border-left)\s*:\s*[^;\n]+/g) ?? []) {
      expect(colour).toMatch(/#[0-9a-f]{3}(?:[0-9a-f]{3})?\b/i);
      expect(colour).not.toMatch(/[{}]/);
    }
    expect(result.html).not.toContain("background: url(");

    // A payload with no url(/expression( in it at all: a whitelist weakened to
    // "anything that does not look dangerous" accepts this, so the assertion
    // has to be about the RULE (literal hex only), not about two literals.
    const injected = renderDeckHtml({
      slides: [{ title: "x" }],
      theme: { primary: "#fff; } body { display: none } .x {" } as never
    });
    expect(injected.ok).toBe(true);
    if (injected.ok) {
      expect(injected.html).not.toContain("body { display: none }");
      expect(injected.html).not.toContain("} body {");
    }
  });

  it("references nothing outside the file", () => {
    const result = renderDeckHtml({ slides: SLIDES });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Positive: the only references a deck may contain are none at all. The
    // negative form missed url(, @import, href= and data: entirely.
    for (const reference of ["http://", "https://", "<link", "src=", "href=", "url(", "@import", "@font-face", "data:"]) {
      expect(result.html, reference).not.toContain(reference);
    }
  });

  it("refuses an empty deck and an oversized one", () => {
    expect(renderDeckHtml({ slides: [] }).ok).toBe(false);
    expect(renderDeckHtml({ slides: undefined }).ok).toBe(false);
    const many = Array.from({ length: MAX_DECK_SLIDES + 1 }, (_, index) => ({ title: `s${index}` }));
    const result = renderDeckHtml({ slides: many });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("over the");
  });

  it("ignores block shapes it does not recognise instead of printing them", () => {
    const result = renderDeckHtml({
      slides: [{ title: "x", blocks: [{ type: "unknown-thing" } as never, { type: "spacer" } as never] }]
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.html).not.toContain("unknown-thing");
  });

  it("renders an unrecognised block's text as a paragraph rather than dropping it", () => {
    // The claim used to be "unknown blocks render as nothing"; that is true of
    // the SHAPE it was tested with (no text) and false of a block that carries
    // text, which becomes a paragraph. Pinned so the wording cannot drift again.
    const result = renderDeckHtml({
      slides: [{ title: "x", blocks: [{ type: "chart-3d", text: "50%" } as never] }]
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toContain("50%");
      expect(result.html).not.toContain("chart-3d");
    }
  });

  it("survives malformed input instead of throwing", () => {
    // write_artifact validates only that `slides` is an array, so a model can
    // emit these; the contract is "HTML or a reason", never a throw (a throw is
    // swallowed by the subscriber and leaves no skip reason at all).
    for (const content of [
      { title: "t", slides: [{ title: "x", blocks: [null] }] },
      { title: "t", slides: [{ title: "x", blocks: [undefined] }] },
      { title: "t", slides: [{ title: "x", blocks: ["nope"] }] },
      { title: {}, slides: [{ title: "x" }] },
      { title: 42, slides: [{ title: "x" }] }
    ]) {
      expect(() => renderDeckHtml(content as never)).not.toThrow();
      expect(renderDeckHtml(content as never).ok).toBe(true);
    }
    // ...and through the delivery decision, which must return a reason.
    expect(() => artifactFileFor(pptArtifact({ type: "ppt", slides: [{ title: "x", blocks: [null] }] } as never), null)).not.toThrow();
  });

  it("shows every slide to a client that cannot run the pager", () => {
    const result = renderDeckHtml({ slides: SLIDES });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('<body class="no-js">');
    expect(result.html).toContain(".no-js .slide { display: block; }");
    expect(result.html).toContain("classList.remove('no-js')");
  });
});

describe("through the delivery decision", () => {
  it("delivers a deck as one .html file", () => {
    const file = artifactFileFor(pptArtifact({ type: "ppt", title: "季度汇报", slides: SLIDES }), null);
    expect("name" in file && file.name).toMatch(/\.html$/);
    expect("content" in file && file.content.toString("utf-8")).toContain("第一点");
  });

  it("refuses an oversized source without rendering it", () => {
    // 200 slides of markup-heavy text: the source check must fire first, so the
    // reason talks about the source rather than the rendered size.
    const slides = Array.from({ length: 200 }, (_, index) => ({
      title: `s${index}`,
      bullets: Array.from({ length: 40 }, () => "&<>".repeat(60))
    }));
    const file = artifactFileFor(pptArtifact({ type: "ppt", slides }), null);
    expect("reason" in file && file.reason).toContain("deck source is");
  });

  it("refuses a deck with no slides instead of sending an empty file", () => {
    const file = artifactFileFor(pptArtifact({ type: "ppt", slides: [] }), null);
    expect("reason" in file && file.reason).toContain("no slides");
  });

  it("forces the extension when the title carries a dotted version", () => {
    for (const title of [
      "季度汇报 v2.0",
      "deck.pptx",
      "设计稿v2.0.pptx",
      "会议纪要.最终版",
      "v1.2.3",
      "a.b.c.d",
      "a.verylongextensionname",
      "..."
    ]) {
      expect(deckFileName(title), title).toMatch(/\.html$/);
    }
  });
});
