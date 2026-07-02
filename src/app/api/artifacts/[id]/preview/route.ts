import fs from "node:fs";
import { getArtifactById, ensureWebAppPreview } from "@/server/artifact-service";
import {
  getStaticResponseHeaders,
  normalizeStaticFilePath,
  resolveStaticFilePath
} from "@/server/static-file-utils";
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
  if (isDeploymentPreviewPath(webAppContent.deploymentPreviewPath)) {
    return Response.redirect(new URL(webAppContent.deploymentPreviewPath, request.url));
  }

  const previewDir = ensureWebAppPreview(artifact);
  const url = new URL(request.url);
  const fileParam = url.searchParams.get("file");
  const entry = fileParam || webAppContent.entry || "index.html";
  const entryPath = resolveStaticFilePath(previewDir, entry);

  if (!entryPath || !fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
    return new Response("Preview entry not found.", { status: 404 });
  }

  if (!entryPath.toLowerCase().endsWith(".html")) {
    const content = fs.readFileSync(entryPath);
    return new Response(new Uint8Array(content), {
      headers: getStaticResponseHeaders(entry)
    });
  }

  const html = fs.readFileSync(entryPath, "utf-8");
  return new Response(wrapPreviewHtml(html, id, entry), {
    headers: getStaticResponseHeaders(entry)
  });
}

function isDeploymentPreviewPath(value: unknown): value is string {
  return typeof value === "string" && /^\/deployments\/dep_[a-zA-Z0-9_-]+\/?$/.test(value);
}

function wrapPreviewHtml(original: string, artifactId: string, entry: string): string {
  const normalizedEntry = normalizeStaticFilePath(entry) ?? "index.html";
  const entrySegments = normalizedEntry.split("/");
  entrySegments.pop();
  const entryDirectory = entrySegments.length > 0
    ? `${entrySegments.map(encodeURIComponent).join("/")}/`
    : "";
  const baseTag = `<base href="/api/artifacts/${encodeURIComponent(artifactId)}/preview/${entryDirectory}">`;

  if (/<head[\s>]/i.test(original)) {
    return original.replace(/<head([^>]*)>/i, `<head$1>\n${baseTag}`);
  }
  if (/<html[\s>]/i.test(original)) {
    return original.replace(/<html([^>]*)>/i, `<html$1>\n<head>${baseTag}</head>`);
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
