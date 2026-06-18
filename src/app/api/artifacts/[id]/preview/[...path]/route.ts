import fs from "node:fs";
import { ensureWebAppPreview, getArtifactById } from "@/server/artifact-service";
import {
  getStaticResponseHeaders,
  resolveStaticFilePath
} from "@/server/static-file-utils";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; path: string[] }> }
) {
  const { id, path } = await context.params;
  const artifact = getArtifactById(id);
  if (!artifact) {
    return new Response("Artifact not found.", { status: 404 });
  }
  if (artifact.type !== "web_app") {
    return new Response("Preview is only available for web_app artifacts.", { status: 400 });
  }

  const requestedPath = path.join("/");
  const filePath = resolveStaticFilePath(ensureWebAppPreview(artifact), requestedPath);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return new Response("File not found.", { status: 404 });
  }

  const content = fs.readFileSync(filePath);
  return new Response(new Uint8Array(content), {
    headers: getStaticResponseHeaders(requestedPath)
  });
}
