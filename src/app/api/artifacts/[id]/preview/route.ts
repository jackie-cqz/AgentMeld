import fs from "node:fs";
import path from "node:path";
import { getArtifactById, ensureWebAppPreview } from "@/server/artifact-service";
import type { ArtifactContent } from "@/shared/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const artifact = getArtifactById(id);
  if (!artifact) {
    return new Response("Artifact not found.", { status: 404 });
  }

  if (artifact.type !== "web_app") {
    return new Response("Preview is only available for web_app artifacts.", { status: 400 });
  }

  const webAppContent = artifact.content as Extract<ArtifactContent, { type: "web_app" }>;

  // Ensure preview files are on disk
  const previewDir = ensureWebAppPreview(artifact);

  // Check if a specific file is requested via query param
  const url = new URL(request.url);
  const fileParam = url.searchParams.get("file");

  if (fileParam) {
    const safeName = path.basename(fileParam);
    const filePath = path.join(previewDir, safeName);
    if (!fs.existsSync(filePath)) {
      return new Response("File not found.", { status: 404 });
    }
    const content = fs.readFileSync(filePath, "utf-8");
    const mime = getMimeType(safeName);
    return new Response(content, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "no-cache"
      }
    });
  }

  // Serve the entry file (index.html by default)
  const entry = webAppContent.entry || "index.html";
  const entryPath = path.join(previewDir, path.basename(entry));

  if (!fs.existsSync(entryPath)) {
    return new Response("Preview entry not found.", { status: 404 });
  }

  const html = fs.readFileSync(entryPath, "utf-8");

  // Inject sandbox-safe wrapper
  const wrapped = wrapPreviewHtml(html, id);

  return new Response(wrapped, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; connect-src 'none';",
      "Cache-Control": "no-cache"
    }
  });
}

function wrapPreviewHtml(original: string, artifactId: string): string {
  const baseTag = `<base href="/api/artifacts/${artifactId}/preview?file=">`;

  if (/<html/i.test(original)) {
    // Inject base tag after <head> for relative resource resolution
    return original.replace(/<head>/i, `<head>\n${baseTag}`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${baseTag}
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; }
</style>
</head>
<body>
${original}
</body>
</html>`;
}

function getMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const mimes: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".woff2": "font/woff2",
    ".woff": "font/woff"
  };
  return mimes[ext] ?? "text/plain";
}
