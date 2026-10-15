import { safeFileName } from "@/server/channels/feishu/file-name";

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
 * So this module has two answers:
 *
 * - `inlineWebApp` — when the whole app is text and every local reference from
 *   the entry can be inlined, return one self-contained HTML document.
 * - `zipWebApp` — otherwise, store the set in a zip so nothing is lost.
 *
 * The zip is written here (stored entries, no compression) rather than pulling
 * in a dependency: the archives are small, deterministic output is easier to
 * test, and a zip writer with no compression is a few dozen lines.
 */

/** Ceiling for one delivered web app, matching the single-file read limit. */
export const MAX_WEB_APP_BYTES = 1_048_576;
const MAX_WEB_APP_FILES = 512;

/**
 * Fold every locally-referenced asset of a single-page app into the entry.
 *
 * Returns a reason instead of guessing when the app cannot be represented as
 * one file: a reference this cannot resolve (a fetched JSON, a dynamic import,
 * a second HTML page) means the zip path is the honest answer.
 */
export function inlineWebApp(
  files: Record<string, string>,
  entry: string
): { ok: true; html: string } | { ok: false; reason: string } {
  const names = Object.keys(files);
  if (names.length === 0) return { ok: false, reason: "the web app has no files" };
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

  // <link rel="stylesheet" href="style.css"> -> <style>…</style>
  html = html.replace(
    /<link\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi,
    (match, href: string) => {
      const file = lookup(files, href);
      if (!file) return match;
      if (!file.name.endsWith(".css")) return match;
      used.add(file.name);
      return `<style>\n${files[file.name]}\n</style>`;
    }
  );

  // <script src="app.js"></script> -> <script>…</script>
  html = html.replace(
    /<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)><\/script>/gi,
    (match, before: string, src: string, after: string) => {
      const file = lookup(files, src);
      if (!file) return match;
      if (!/\.(m?js|cjs)$/i.test(file.name)) return match;
      used.add(file.name);
      // Re-emit only the attribute that still means something inline: a
      // module keeps its type, while src/defer/async/integrity do not apply.
      // (Whitespace from the original tag must not leak into `<script >`.)
      const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(`${before} ${after}`);
      const attributes = type ? ` type="${type[1]}"` : "";
      return `<script${attributes}>\n${files[file.name]}\n</script>`;
    }
  );

  // One rule, and the strict one: every file in the app other than the entry
  // must have been inlined. A file left over is either referenced in a way
  // this cannot fold (a fetched JSON, a dynamic import) or not referenced at
  // all — in both cases the single file would be missing part of the app, and
  // a zip that keeps everything is the honest answer.
  const notInlined = names.filter((name) => name !== normalizedEntry && name !== entry && !used.has(name));
  if (notInlined.length > 0) {
    return { ok: false, reason: `"${notInlined[0]}" is part of the app but was not inlined` };
  }

  return { ok: true, html };
}

/** The name to send a self-contained app under. */
export function inlineWebAppName(title: string): string {
  return safeFileName(title, "web-app", ".html");
}

export function zipWebAppName(title: string): string {
  return safeFileName(title, "web-app", ".zip");
}

/**
 * Store a file set as a zip. Uncompressed entries: the artifact is already in
 * memory, the sizes are bounded, and "does the archive contain what it says"
 * is easier to assert when the bytes are verbatim.
 */
export function zipWebApp(files: Record<string, string>): Buffer {
  const names = Object.keys(files).sort();
  if (names.length > MAX_WEB_APP_FILES) {
    throw new Error(`a web app with ${names.length} files is over the ${MAX_WEB_APP_FILES} file limit`);
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

function normalize(path: string): string {
  return path.replace(/^\.\//, "").replace(/^\//, "");
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

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
