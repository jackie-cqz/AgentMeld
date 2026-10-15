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
  });

  it("escapes markup everywhere text can come from", () => {
    const result = renderDeckHtml({
      title: '<script>alert("title")</script>',
      slides: [
        {
          title: "<img src=x onerror=alert(1)>",
          subtitle: "\"><script>bad()</script>",
          bullets: ["<b>bold?</b>"],
          notes: "</aside><script>notes()</script>",
          blocks: [
            { type: "metric", value: "<svg onload=alert(2)>", label: "&label" },
            { type: "quote", text: "<iframe src='x'>", author: "<i>a</i>" },
            { type: "columns", columns: [{ title: "<u>t</u>", text: "<em>x</em>" }] },
            { type: "timeline", items: [{ title: "<h1>t</h1>", text: "<p>x</p>" }] },
            { type: "callout", title: "<style>*{}</style>", text: "<script>y</script>" }
          ]
        }
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
  });

  it("references nothing outside the file", () => {
    const result = renderDeckHtml({ slides: SLIDES });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).not.toMatch(/https?:\/\//);
    expect(result.html).not.toContain("<link");
    expect(result.html).not.toContain("src=");
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
});

describe("through the delivery decision", () => {
  it("delivers a deck as one .html file", () => {
    const file = artifactFileFor(pptArtifact({ type: "ppt", title: "季度汇报", slides: SLIDES }), null);
    expect("name" in file && file.name).toMatch(/\.html$/);
    expect("content" in file && file.content.toString("utf-8")).toContain("第一点");
  });

  it("refuses a deck with no slides instead of sending an empty file", () => {
    const file = artifactFileFor(pptArtifact({ type: "ppt", slides: [] }), null);
    expect("reason" in file && file.reason).toContain("no slides");
  });

  it("forces the extension when the title carries a dotted version", () => {
    expect(deckFileName("季度汇报 v2.0")).toMatch(/\.html$/);
    expect(deckFileName("deck.pptx")).toMatch(/\.html$/);
  });
});
