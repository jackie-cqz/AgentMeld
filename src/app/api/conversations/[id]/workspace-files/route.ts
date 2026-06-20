import fs from "node:fs";
import path from "node:path";
import { getWorkspaceForConversation } from "@/server/repositories";
import { resolveStaticFilePath } from "@/server/static-file-utils";
import { isPathWithin } from "@/server/workspace-utils";

export const dynamic = "force-dynamic";

const MAX_TEXT_CHARS = 50_000;
const MAX_READ_BYTES = 256 * 1024;
const MAX_ENTRIES = 2_000;

// Common binary extensions and magic bytes
const BINARY_EXTS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".db", ".sqlite",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".ogg", ".flac",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".wasm", ".o", ".obj", ".class", ".pyc",
]);
const TEXT_EXTS = new Set([
  ".txt", ".md", ".json", ".xml", ".yml", ".yaml", ".toml", ".ini", ".cfg",
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
  ".html", ".htm", ".css", ".scss", ".less",
  ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp",
  ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd",
  ".sql", ".graphql", ".proto", ".env", ".gitignore", ".dockerignore",
  ".csv", ".tsv", ".log",
]);

function isBinaryByExt(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  if (BINARY_EXTS.has(ext)) return true;
  if (TEXT_EXTS.has(ext)) return false;
  return false; // unknown ext → assume text, check NUL later
}

function hasNulBytes(buffer: Buffer): boolean {
  return buffer.indexOf(0) >= 0;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const dirPath = url.searchParams.get("path") || ".";
  const readFile = url.searchParams.get("read") === "1";

  const workspace = getWorkspaceForConversation(id);
  if (!workspace) {
    return Response.json({ error: "Workspace not found." }, { status: 404 });
  }

  const rootPath = workspace.mode === "local" && workspace.boundPath ? workspace.boundPath : workspace.rootPath;
  if (!fs.existsSync(rootPath)) {
    return Response.json({ entries: [] });
  }

  // P0: realpath verification on workspace root
  let realRoot: string;
  try { realRoot = fs.realpathSync(rootPath); } catch {
    return Response.json({ error: "Workspace root not accessible." }, { status: 500 });
  }

  try {
    const logicalPath = dirPath === "." ? rootPath : resolveStaticFilePath(rootPath, dirPath);
    if (!logicalPath) {
      return Response.json({ error: "Invalid path format." }, { status: 400 });
    }

    // P0: realpath verification on target
    let realTarget: string;
    try { realTarget = fs.realpathSync(logicalPath); } catch {
      return Response.json({ error: "Path not found." }, { status: 404 });
    }
    if (!isPathWithin(realTarget, realRoot)) {
      return Response.json({ error: "Path escapes workspace boundary." }, { status: 403 });
    }

    if (readFile) {
      // P0.3: Read file with size limits and binary detection
      let stat: fs.Stats;
      try { stat = fs.statSync(realTarget); } catch {
        return Response.json({ error: "File not found." }, { status: 404 });
      }
      if (!stat.isFile()) {
        return Response.json({ error: "Not a file." }, { status: 400 });
      }
      if (isBinaryByExt(path.basename(realTarget))) {
        return Response.json({ error: "Binary file preview not supported." }, { status: 415 });
      }

      // Read only needed bytes, not entire file
      const readSize = Math.min(stat.size, MAX_READ_BYTES);
      let buffer: Buffer;
      try {
        const handle = fs.openSync(realTarget, "r");
        buffer = Buffer.alloc(readSize);
        fs.readSync(handle, buffer, 0, readSize, 0);
        fs.closeSync(handle);
      } catch {
        return Response.json({ error: "Failed to read file." }, { status: 500 });
      }

      if (hasNulBytes(buffer)) {
        return Response.json({ error: "Binary content detected." }, { status: 415 });
      }

      let content = buffer.toString("utf-8");
      const truncated = content.length > MAX_TEXT_CHARS;
      if (truncated) content = content.slice(0, MAX_TEXT_CHARS) + "\n...(truncated)";

      return Response.json({
        content, truncated, size: stat.size, encoding: "utf-8",
        path: path.relative(rootPath, realTarget)
      });
    }

    // List directory
    if (!fs.statSync(realTarget).isDirectory()) {
      return Response.json({ error: "Not a directory." }, { status: 400 });
    }

    const rawEntries = fs.readdirSync(realTarget, { withFileTypes: true })
      .filter((d) => !d.name.startsWith("."));

    if (rawEntries.length > MAX_ENTRIES) {
      return Response.json({ error: `Directory too large (${rawEntries.length} entries, max ${MAX_ENTRIES}).` }, { status: 400 });
    }

    const entries = rawEntries
      .filter((d) => {
        // P0: filter symlinks in listing for safety
        if (d.isSymbolicLink()) return false;
        return true;
      })
      .map((d) => {
        const entryPath = path.join(realTarget, d.name);
        let size: number | undefined;
        try {
          if (d.isFile()) size = fs.statSync(entryPath).size;
        } catch { /* file may have been deleted */ }
        return {
          name: d.name,
          type: d.isDirectory() ? "directory" as const : "file" as const,
          size
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return Response.json({ entries });
  } catch (err) {
    if (err instanceof Error && "code" in err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return Response.json({ error: "Path not found." }, { status: 404 });
      if (code === "EACCES" || code === "EPERM") return Response.json({ error: "Permission denied." }, { status: 403 });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Failed to read workspace." }, { status: 500 });
  }
}
