import path from "node:path";
import { safeFileName } from "@/server/channels/feishu/file-name";
import { normalizeStaticFilePath } from "@/server/static-file-utils";
import { MAX_FILE_READ_BYTES } from "@/server/workspace-utils";

/**
 * Turning a web_app artifact into something a chat member can actually open.
 *
 * §7.3 recorded "no entry point" for artifacts because a chat member has no
 * route to a locally stored file. A file upload needs no route — but a web app
 * is a SET of files, and the earlier delivery decision refused it outright
 * ("a .html attachment is not [opening it in a browser]"). That refusal was
 * right about a multi-file app and wrong about the common case: a generated
 * single-page app whose assets are all text can be folded into ONE file that
 * opens in a browser with nothing else.
 *
 * Folding has to be FAITHFUL or not happen at all. Every rule below exists
 * because a review found the naive version producing a page that looked
 * delivered and was broken:
 *
 * - a `</script` or `</style` inside a folded file would terminate the block
 *   early (the sequence is legal in an external file and fatal once inlined);
 * - a classic `defer`/`async` script executes at its parse position when
 *   inlined, which is not what it asked for;
 * - a module's relative imports have no URL to resolve against once inlined;
 * - a reference left behind anywhere in the document — including inside a
 *   comment or a string — still points at a file that is not beside it;
 * - and anything that is not inlined means the single file is missing part of
 *   the app.
 *
 * Anything that fails these becomes a zip instead. The zip is written here
 * (stored entries, no compression) rather than pulling in a dependency: the
 * archives are small, deterministic output is easier to test, and a zip writer
 * with no compression is a few dozen lines.
 *
 * What is NOT claimed: how a chat client renders either file. That needs a
 * human in a real room, and the operations guide says so.
 */

/** Ceiling for one delivered web app, matching the single-file read limit. */
export const MAX_WEB_APP_BYTES = MAX_FILE_READ_BYTES;
const MAX_WEB_APP_FILES = 512;

type InlineResult = { ok: true; html: string } | { ok: false; reason: string };

/**
 * Fold every locally-referenced asset of a single-page app into the entry.
 *
 * Returns a reason instead of guessing when the app cannot be represented as
 * one file.
 */
export function inlineWebApp(
  files: Record<string, string>,
  entry: string
): InlineResult {
  if (!files || typeof files !== "object") {
    return { ok: false, reason: "the web app has no file map" };
  }
  const names = Object.keys(files);
  if (names.length === 0) return { ok: false, reason: "the web app has no files" };
  for (const name of names) {
    if (typeof files[name] !== "string") {
      return { ok: false, reason: `"${name}" is not text` };
    }
  }

  const normalizedEntry = normalize(entry);
  if (!normalizedEntry.endsWith(".html")) {
    return { ok: false, reason: `the entry "${entry}" is not an HTML page` };
  }
  const entryHtml = files[entry] ?? files[normalizedEntry];
  if (entryHtml === undefined) {
    return { ok: false, reason: `the entry "${entry}" is not among the files` };
  }

  const used = new Set<string>();
  let html = entryHtml;
  let refusal: string | null = null;

  // <link rel="stylesheet" href="style.css"> -> <style>…</style>
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const href = attributeValue(tag, "href");
    if (!href) return tag;
    const file = lookup(files, href);
    if (!file) return tag;
    if (!/\bstylesheet\b/i.test(attributeValue(tag, "rel") ?? "")) {
      refusal ??= `the entry loads "${file.name}" with a rel this cannot inline`;
      return tag;
    }
    if (!/\.css$/i.test(file.name)) {
      refusal ??= `the entry references "${file.name}", which is not a stylesheet`;
      return tag;
    }
    const body = files[file.name];
    if (containsBlockTerminator(body, "style")) {
      refusal ??= `"${file.name}" contains text that would end the style block early`;
      return tag;
    }
    used.add(file.name);
    return `<style>\n${body}\n</style>`;
  });

  // <script src="app.js"></script> -> <script>…</script>
  html = html.replace(/<script\b[^>]*><\/script>/gi, (tag) => {
    const src = attributeValue(tag, "src");
    if (!src) return tag;
    const file = lookup(files, src);
    if (!file) return tag;
    if (!/\.(m?js|cjs)$/i.test(file.name)) {
      refusal ??= `the entry references "${file.name}", which is not a script`;
      return tag;
    }
    if (hasAttribute(tag, "nomodule")) {
      refusal ??= `"${file.name}" is loaded with nomodule, which an inline script cannot keep`;
      return tag;
    }
    if (hasAttribute(tag, "async") || hasAttribute(tag, "defer")) {
      // An inline classic script runs where it sits; defer/async asked for
      // something else. Relocating it would be a rewrite, not a fold.
      refusal ??= `"${file.name}" is loaded with defer or async, which an inline script cannot keep`;
      return tag;
    }
    const type = attributeValue(tag, "type");
    const body = files[file.name];
    if (containsBlockTerminator(body, "script")) {
      refusal ??= `"${file.name}" contains text that would end the script block early`;
      return tag;
    }
    if (type && /\bmodule\b/i.test(type)) {
      if (hasRelativeImport(body)) {
        // An inline module has no URL of its own, so "./dep.js" can never
        // resolve — even when dep.js is also packed into this document.
        refusal ??= `"${file.name}" is a module with a relative import, which cannot resolve once inlined`;
        return tag;
      }
      used.add(file.name);
      return `<script type="module">\n${body}\n</script>`;
    }
    if (type) {
      refusal ??= `"${file.name}" is a ${type} script, which inline cannot keep`;
      return tag;
    }
    used.add(file.name);
    return `<script>\n${body}\n</script>`;
  });

  if (refusal) return { ok: false, reason: refusal };

  // Nothing may still point at a file that will not be beside the document.
  // This is what catches a reference the regexes above did not rewrite — an
  // unquoted attribute, a mention inside a comment or a string — which the
  // previous "was this file inlined somewhere?" rule could not see.
  const leftover = leftoverReference(html, files);
  if (leftover) {
    return { ok: false, reason: `the entry still references "${leftover}"` };
  }

  // And nothing may be left out: an unreferenced extra file would be dropped
  // silently, which is the failure the old refusal existed to prevent.
  const notInlined = names.filter((name) => name !== normalizedEntry && name !== entry && !used.has(name));
  if (notInlined.length > 0) {
    return { ok: false, reason: `"${notInlined[0]}" is part of the app but was not inlined` };
  }

  return { ok: true, html };
}

/** Names to send the two shapes under, with the extension forced. */
export function inlineWebAppName(title: string): string {
  return safeFileName(stripExtension(title), "web-app", ".html");
}

export function zipWebAppName(title: string): string {
  return safeFileName(stripExtension(title), "web-app", ".zip");
}

/**
 * A `safeFileName` keeps whatever extension the title already had, so "v2.0"
 * became a delivered file named "v2.0" with no extension and "index.html"
 * became a ZIP called index.html. The extension is decided by the content.
 */
function stripExtension(title: string): string {
  const trimmed = title.trim();
  const withoutExtension = trimmed.replace(/\.[A-Za-z0-9]{1,8}$/, "").trim();
  return withoutExtension.length > 0 ? withoutExtension : trimmed;
}

/**
 * Store a file set as a zip. Uncompressed entries: the artifact is already in
 * memory, the sizes are bounded, and "does the archive contain what it says"
 * is easier to assert when the bytes are verbatim.
 */
export function zipWebApp(files: Record<string, string>): Buffer {
  const names = Object.keys(files).sort();
  if (names.length === 0) throw new Error("the web app has no files");
  if (names.length > MAX_WEB_APP_FILES) {
    throw new Error(`a web app with ${names.length} files is over the ${MAX_WEB_APP_FILES} file limit`);
  }
  for (const name of names) {
    // The same rule the preview route applies to these same file names: a zip
    // is extracted by its recipient, and a "../" entry writes outside wherever
    // they put it.
    // normalizeStaticFilePath rewrites "\" to "/", which is right for serving a
    // path and wrong for an archive entry: extractors disagree about what a
    // backslash means, so a name containing one is refused rather than
    // silently reinterpreted.
    if (name.includes("\\") || !normalizeStaticFilePath(name)) {
      throw new Error(`the file name "${name}" is not a safe archive entry`);
    }
    if (typeof files[name] !== "string") {
      throw new Error(`"${name}" is not text`);
    }
  }

  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const name of names) {
    const data = Buffer.from(files[name], "utf-8");
    const nameBytes = Buffer.from(name, "utf-8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01, deterministic
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBytes, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10); // stored
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // disk
    entry.writeUInt16LE(0, 36); // internal attrs
    entry.writeUInt32LE(0, 38); // external attrs
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuffer, end]);
}

/**
 * The first reference left in the document that names one of the app's own
 * files. Attribute values are read with or without quotes, because an unquoted
 * `src=app.js` is valid HTML and was invisible to the earlier pattern.
 */
function leftoverReference(html: string, files: Record<string, string>): string | null {
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    const reference = match[1] ?? match[2] ?? match[3] ?? "";
    if (/^(?:https?:|data:|mailto:|#|\/\/)/i.test(reference)) continue;
    const file = lookup(files, reference);
    if (file) return file.name;
  }
  return null;
}

/** Read one attribute out of a tag, quoted or not, without matching `data-type`. */
function attributeValue(tag: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = pattern.exec(tag);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

/**
 * Is this attribute present at all? `defer`, `async` and `nomodule` are
 * boolean: `<script defer src=…>` carries no value, so a value-reading pattern
 * never sees it and the script would be inlined as if it had asked for nothing.
 */
function hasAttribute(tag: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?=\\s|=|>|$)`, "i").test(tag);
}

/** Does this text contain a sequence that would close the given block early? */
function containsBlockTerminator(body: string, block: "script" | "style"): boolean {
  return new RegExp(`</${block}`, "i").test(body);
}

/** A module's bare or relative specifier, which an inline module cannot resolve. */
function hasRelativeImport(body: string): boolean {
  const patterns = [
    /\bimport\s*\(\s*["']\.{1,2}\//,
    /\bimport\s+[^;]*?from\s*["']\.{1,2}\//,
    /\bexport\s+[^;]*?from\s*["']\.{1,2}\//
  ];
  return patterns.some((pattern) => pattern.test(body));
}

/** Resolve an HTML reference against the file map, tolerating `./` and a leading `/`. */
function lookup(files: Record<string, string>, reference: string): { name: string } | null {
  const candidates = [reference, normalize(reference)];
  const bare = reference.replace(/^\.\//, "").replace(/^\//, "");
  candidates.push(bare, normalize(bare));
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(files, candidate)) return { name: candidate };
  }
  return null;
}

function normalize(filePath: string): string {
  return filePath.replace(/^\.\//, "").replace(/^\//, "");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Kept for callers that only want the name shape. */
export function webAppBaseNames(title: string): { html: string; zip: string } {
  return {
    html: path.basename(inlineWebAppName(title)),
    zip: path.basename(zipWebAppName(title))
  };
}
