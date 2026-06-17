import fs from "node:fs";
import path from "node:path";
import { getArtifactById, ensureWebAppPreview } from "@/server/artifact-service";
import type { ArtifactContent } from "@/shared/types";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
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

  // Serve the entry file (index.html by default)
  const entry = webAppContent.entry || "index.html";
  const entryPath = path.join(previewDir, path.basename(entry));

  if (!fs.existsSync(entryPath)) {
    return new Response("Preview entry not found.", { status: 404 });
  }

  const html = fs.readFileSync(entryPath, "utf-8");

  // Inject sandbox-safe wrapper
  const wrapped = wrapPreviewHtml(html);

  return new Response(wrapped, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; connect-src 'none';",
      "Cache-Control": "no-cache"
    }
  });
}

function wrapPreviewHtml(original: string): string {
  // If HTML already has <html>, serve as-is (iframe sandbox handles security)
  if (/<html/i.test(original)) return original;

  // Wrap bare HTML in a minimal document
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
