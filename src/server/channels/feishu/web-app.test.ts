import { describe, expect, it } from "vitest";
import {
  MAX_WEB_APP_BYTES,
  inlineWebApp,
  inlineWebAppName,
  zipWebApp,
  zipWebAppName
} from "@/server/channels/feishu/web-app";
import { artifactFileFor } from "@/server/channels/feishu/artifact-delivery";
import type { Artifact } from "@/shared/types";

/**
 * A web app is the one artifact type that was never delivered, for a reason
 * that was half right: one file out of a set is worse than nothing, but a
 * single-page app with text assets fits in one file exactly. These tests hold
 * the line between "faithful fold" and "silently lossy".
 */

function artifactWithWebApp(files: Record<string, string>, entry = "index.html"): Artifact {
  return {
    id: "art_1",
    conversationId: "conv_1",
    title: "示例应用",
    type: "web_app",
    content: { type: "web_app", files, entry },
    createdByAgentId: "ag_1",
    createdAt: 1,
    updatedAt: 1
  } as unknown as Artifact;
}

const SINGLE_PAGE = {
  "index.html": [
    "<!doctype html><html><head>",
    '<link rel="stylesheet" href="style.css">',
    "</head><body><div id=app></div>",
    '<script src="script.js"></script>',
    "</body></html>"
  ].join(""),
  "style.css": "body{color:red}",
  "script.js": "document.getElementById('app').textContent='ok';"
};

describe("folding a single-page app into one file", () => {
  it("inlines the stylesheet and the script it references", () => {
    const result = inlineWebApp(SINGLE_PAGE, "index.html");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The content travels, the references do not.
    expect(result.html).toContain("body{color:red}");
    expect(result.html).toContain("getElementById");
    expect(result.html).not.toContain('href="style.css"');
    expect(result.html).not.toContain('src="script.js"');
    // Still a page, not a concatenation of files.
    expect(result.html).toContain("<style>");
    expect(result.html).toContain("<script>");
  });

  it("resolves ./ and leading-slash references", () => {
    const result = inlineWebApp(
      {
        "index.html": '<link rel="stylesheet" href="/assets/style.css"><script src="./app.js"></script>',
        "assets/style.css": ".a{}",
        "app.js": "1;"
      },
      "index.html"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toContain(".a{}");
      expect(result.html).toContain("1;");
    }
  });

  it("refuses when a referenced asset cannot be folded in", () => {
    // A JSON the page fetches is not an inline asset: the single file would be
    // broken the moment it runs.
    const result = inlineWebApp(
      {
        "index.html": '<script>fetch("data.json")</script><script src="app.js"></script>',
        "data.json": '{"a":1}',
        "app.js": "1;"
      },
      "index.html"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("data.json");
  });

  it("refuses a linked file it cannot inline (and says which)", () => {
    // The direct path: a <link> to a real file that is not a stylesheet.
    const result = inlineWebApp(
      { "index.html": '<link rel="preload" href="theme.json">', "theme.json": "{}" },
      "index.html"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("theme.json");
  });

  it("refuses when the entry does not reference the app's other files", () => {
    // Inlining one file and dropping the rest is exactly the failure the old
    // refusal existed to prevent.
    const result = inlineWebApp({ "index.html": "<p>x</p>", "other.js": "1;" }, "index.html");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("other.js");
  });

  it("refuses a non-HTML entry and a missing entry", () => {
    expect(inlineWebApp({ "main.js": "1;" }, "main.js").ok).toBe(false);
    expect(inlineWebApp({ "index.html": "<p>x</p>" }, "missing.html").ok).toBe(false);
    expect(inlineWebApp({}, "index.html").ok).toBe(false);
  });
});

describe("zipping a web app that cannot be folded", () => {
  it("stores every file verbatim, with an archive that names them", () => {
    const files = { "index.html": "<p>x</p>", "assets/app.js": "const a = 1;", "data.json": '{"a":1}' };
    const zip = zipWebApp(files);

    // Stored (uncompressed) entries, so the payload appears verbatim.
    for (const [name, content] of Object.entries(files)) {
      expect(zip.includes(Buffer.from(name, "utf-8"))).toBe(true);
      expect(zip.includes(Buffer.from(content, "utf-8"))).toBe(true);
    }
    // Local header, central directory, end-of-central-directory.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.includes(Buffer.from([0x50, 0x4b, 0x01, 0x02]))).toBe(true);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(3);
  });

  it("is deterministic", () => {
    const files = { "b.js": "2;", "a.js": "1;" };
    expect(zipWebApp(files).equals(zipWebApp(files))).toBe(true);
  });

  it("refuses an absurd file count rather than building it", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 600; i++) many[`f${i}.js`] = "1;";
    expect(() => zipWebApp(many)).toThrow(/file limit/);
  });
});

describe("names", () => {
  it("gives the two shapes distinct extensions", () => {
    expect(inlineWebAppName("示例应用")).toMatch(/\.html$/);
    expect(zipWebAppName("示例应用")).toMatch(/\.zip$/);
  });
});

describe("through the delivery decision", () => {
  it("delivers a foldable app as one HTML file", () => {
    const file = artifactFileFor(artifactWithWebApp(SINGLE_PAGE), null);
    expect("name" in file && file.name).toMatch(/\.html$/);
    expect("content" in file && file.content.toString("utf-8")).toContain("body{color:red}");
  });

  it("delivers an unfoldable app as a zip", () => {
    const file = artifactFileFor(
      artifactWithWebApp({ "index.html": "<p>x</p>", "big.bin.js": "1;" }),
      null
    );
    expect("name" in file && file.name).toMatch(/\.zip$/);
  });

  it("refuses an app over the size limit instead of truncating it", () => {
    const huge = { "index.html": "<p>x</p>", "app.js": "1;".repeat(MAX_WEB_APP_BYTES) };
    const file = artifactFileFor(artifactWithWebApp(huge), null);
    expect("reason" in file && file.reason).toContain("over the");
  });
});
