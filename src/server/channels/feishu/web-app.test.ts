import { describe, expect, it } from "vitest";
import {
  MAX_WEB_APP_BYTES,
  crc32,
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

/**
 * A real ZIP reader for the assertions below.
 *
 * The first version of these tests only checked that bytes "appeared" in the
 * archive, and a mutation that wrote 0 into every central-directory offset —
 * producing an archive `unzip -t` rejects — left them all green. This walks the
 * structure the way a reader does: end-of-central-directory, central entries,
 * each one's local header at its recorded offset, and the CRC of the stored
 * bytes.
 */
function readZip(zip: Buffer) {
  const eocd = zip.length - 22;
  if (zip.readUInt32LE(eocd) !== 0x06054b50) throw new Error("no end-of-central-directory record");
  const count = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize !== eocd) throw new Error("central directory size/offset disagree");

  const entries: Array<{ name: string; content: string; crcMatches: boolean; localHeaderOk: boolean }> = [];
  let cursor = centralOffset;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`entry ${i}: bad central signature`);
    const crc = zip.readUInt32LE(cursor + 16);
    const size = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf-8");

    const localHeaderOk = zip.readUInt32LE(localOffset) === 0x04034b50;
    const localCrc = zip.readUInt32LE(localOffset + 14);
    const localCompSize = zip.readUInt32LE(localOffset + 18);
    const localSize = zip.readUInt32LE(localOffset + 22);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const content = zip.subarray(dataStart, dataStart + size).toString("utf-8");
    const localName = zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf-8");
    const actualCrc = crc32(Buffer.from(content, "utf-8"));

    entries.push({
      name,
      content,
      // Both headers, all three fields: `unzip -t` rejects an archive whose
      // LOCAL header disagrees even when the central directory is consistent,
      // and a reader that only walks the central directory would not notice.
      crcMatches:
        crc === actualCrc &&
        localCrc === actualCrc &&
        localCompSize === size &&
        localSize === size &&
        localName === name,
      localHeaderOk
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe("the zip is structurally real, not just byte-shaped", () => {
  it("recomputes a known CRC32 vector", () => {
    // Pins the checksum table against the published value for "hello".
    expect(crc32(Buffer.from("hello"))).toBe(0x3610a686);
  });

  it("walks every entry to its local header and checksums the bytes", () => {
    const files = { "index.html": "<p>x</p>", "assets/app.js": "const a = 1;", "data.json": '{"a":1}' };
    const entries = readZip(zipWebApp(files));

    expect(entries.map((entry) => entry.name).sort()).toEqual(Object.keys(files).sort());
    for (const entry of entries) {
      expect(entry.localHeaderOk).toBe(true);
      expect(entry.crcMatches).toBe(true);
      expect(entry.content).toBe(files[entry.name as keyof typeof files]);
    }
  });

  it("survives a file set with an empty file and a deep path", () => {
    const files = { "a/b/c/d.txt": "", "index.html": "x" };
    const entries = readZip(zipWebApp(files));
    expect(entries.find((entry) => entry.name === "a/b/c/d.txt")?.content).toBe("");
    expect(entries.every((entry) => entry.crcMatches && entry.localHeaderOk)).toBe(true);
  });
});

describe("fold rules a review proved were missing", () => {
  it("refuses a script whose text would close the script block early", () => {
    const result = inlineWebApp(
      { "index.html": '<script src="app.js"></script>', "app.js": 'const s = "</script>";' },
      "index.html"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("end the script block");
  });

  it("refuses a stylesheet whose text would close the style block early", () => {
    const result = inlineWebApp(
      { "index.html": '<link rel="stylesheet" href="a.css">', "a.css": "/* </style> */ body{}" },
      "index.html"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("end the style block");
  });

  it("refuses defer and async rather than running the script early", () => {
    // An inline classic script runs where it sits; a deferred head script
    // expects the DOM to exist.
    for (const attribute of ["defer", "async"]) {
      const result = inlineWebApp(
        { "index.html": `<head><script ${attribute} src="app.js"></script></head>`, "app.js": "go();" },
        "index.html"
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("defer or async");
    }
  });

  it("refuses when a packaged file is still referenced after folding", () => {
    // style.css IS inlined, so the "was every file inlined?" rule is happy —
    // but an <img> still points at it, and that file will not be beside the
    // delivered page. This is what the earlier rule could not see.
    const result = inlineWebApp(
      {
        "index.html": '<link rel="stylesheet" href="style.css"><img src="style.css">',
        "style.css": "body{}"
      },
      "index.html"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("still references");
  });

  it("refuses a module with a relative import", () => {
    // An inline module has no URL, so "./dep.js" can never resolve — even when
    // dep.js is packed into the same document.
    const result = inlineWebApp(
      {
        "index.html": '<script type="module" src="main.js"></script><script src="dep.js"></script>',
        "main.js": "import { x } from './dep.js';",
        "dep.js": "export const x = 1;"
      },
      "index.html"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("relative import");
  });

  it("keeps type=module on an inline module that has no relative import", () => {
    const result = inlineWebApp(
      { "index.html": '<script type="module" src="main.js"></script>', "main.js": "console.log(1);" },
      "index.html"
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.html).toContain('<script type="module">');
  });

  it("does not mistake data-type for type", () => {
    const result = inlineWebApp(
      { "index.html": '<script data-type="module" src="app.js"></script>', "app.js": "1;" },
      "index.html"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toContain("<script>");
      expect(result.html).not.toContain('type="module"');
    }
  });

  it("refuses nomodule, which an inline script cannot keep", () => {
    const result = inlineWebApp(
      { "index.html": '<script nomodule src="legacy.js"></script>', "legacy.js": "1;" },
      "index.html"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("nomodule");
  });

  it("refuses a stylesheet loaded with a rel it would change the meaning of", () => {
    const result = inlineWebApp(
      { "index.html": '<link rel="preload" as="style" href="style.css">', "style.css": "body{}" },
      "index.html"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("rel");
  });

  it("accepts an uppercase .CSS extension", () => {
    const result = inlineWebApp(
      { "index.html": '<link rel="stylesheet" href="Style.CSS">', "Style.CSS": "body{}" },
      "index.html"
    );
    expect(result.ok).toBe(true);
  });

  it("refuses to pack an entry name that escapes the archive", () => {
    // The preview route already refuses these names for the same file set; the
    // zip is extracted by its recipient, so it must refuse them too.
    for (const name of ["../evil.js", "/abs.js", "a\\b.js", "a/../b.js", ""]) {
      expect(() => zipWebApp({ [name]: "x" })).toThrow(/safe archive entry|no files/);
    }
  });

  it("refuses malformed content instead of throwing", () => {
    expect(inlineWebApp({ "index.html": 42 as unknown as string }, "index.html").ok).toBe(false);
    expect(inlineWebApp(undefined as unknown as Record<string, string>, "index.html").ok).toBe(false);
  });
});

describe("references the leftover scan has to cover", () => {
  it("catches srcset, poster, object data and form action", () => {
    for (const markup of [
      '<img srcset="s.css 1x">',
      '<video poster="s.css"></video>',
      '<object data="s.css"></object>',
      '<form action="s.css"></form>'
    ]) {
      const result = inlineWebApp(
        { "index.html": `<link rel="stylesheet" href="s.css">${markup}`, "s.css": "body{}" },
        "index.html"
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("still references");
    }
  });

  it("catches url() and @import inside a folded stylesheet", () => {
    const result = inlineWebApp(
      {
        "index.html": '<link rel="stylesheet" href="a.css">',
        "a.css": '@import url("b.css"); .x{background:url(b.png)}',
        "b.css": "body{}",
        "b.png": "PNG"
      },
      "index.html"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("still references");
  });

  it("refuses a document that re-bases its references with <base>", () => {
    const result = inlineWebApp(
      {
        "index.html": '<base href="assets/"><link rel="stylesheet" href="style.css">',
        "style.css": "body{}"
      },
      "index.html"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("<base href>");
  });

  it("still refuses a self-link, because the delivered file has another name", () => {
    // The single file is delivered under the artifact title, so an app-shell
    // link to index.html would be broken; the zip keeps it working.
    const result = inlineWebApp({ "index.html": '<p>x</p><a href="index.html">home</a>' }, "index.html");
    expect(result.ok).toBe(false);
  });
});

describe("module specifiers an inline module cannot resolve", () => {
  it("catches the side-effect import form", () => {
    const result = inlineWebApp(
      {
        "index.html": '<script type="module" src="m.js"></script><script src="dep.js"></script>',
        "m.js": "import './dep.js';",
        "dep.js": "export const x = 1;"
      },
      "index.html"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("relative import");
  });

  it("catches root-relative and bare specifiers too", () => {
    for (const specifier of ["/dep.js", "dep", "../dep.js"]) {
      const result = inlineWebApp(
        {
          "index.html": '<script type="module" src="m.js"></script><script src="dep.js"></script>',
          "m.js": `import x from '${specifier}';`,
          "dep.js": "export const x = 1;"
        },
        "index.html"
      );
      expect(result.ok).toBe(false);
    }
  });

  it("allows a module whose only import is absolute", () => {
    const result = inlineWebApp(
      { "index.html": '<script type="module" src="m.js"></script>', "m.js": 'import x from "https://cdn.example/x.js";' },
      "index.html"
    );
    expect(result.ok).toBe(true);
  });
});

describe("small things a review measured", () => {
  it("folds text/javascript and application/javascript like no type at all", () => {
    for (const type of ["text/javascript", "application/javascript"]) {
      const result = inlineWebApp(
        { "index.html": `<script type="${type}" src="a.js"></script>`, "a.js": "1;" },
        "index.html"
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.html).toContain("<script>");
    }
    const other = inlineWebApp(
      { "index.html": '<script type="application/json" src="d.json"></script>', "d.json": "{}" },
      "index.html"
    );
    expect(other.ok).toBe(false);
  });

  it("forces the extension even for a trailing dot or a long suffix", () => {
    expect(inlineWebAppName("app.")).toMatch(/\.html$/);
    expect(zipWebAppName("site.verylongext")).toMatch(/\.zip$/);
  });

  it("refuses the double-escape sequence that would swallow the document", () => {
    const result = inlineWebApp(
      { "index.html": '<script src="app.js"></script>', "app.js": 'const s = "<!--<script>";' },
      "index.html"
    );
    expect(result.ok).toBe(false);
  });

  it("refuses an entry name longer than a zip entry allows, in plain words", () => {
    const huge = "x".repeat(70_000);
    expect(() => zipWebApp({ [huge]: "1;" })).toThrow(/longer than a zip entry allows/);
  });
});

describe("delivered names force the extension", () => {
  it("does not let a dotted title swallow the extension", () => {
    // safeFileName keeps an existing extension, so "Dashboard 2.0" was
    // delivered as a file named "Dashboard 2.0" with none.
    expect(inlineWebAppName("Dashboard 2.0")).toMatch(/\.html$/);
    expect(zipWebAppName("我的应用 v1.0")).toMatch(/\.zip$/);
  });

  it("does not deliver a zip under an .html name", () => {
    expect(zipWebAppName("index.html")).toMatch(/\.zip$/);
    expect(zipWebAppName("index.html")).not.toMatch(/\.html$/);
  });
});
