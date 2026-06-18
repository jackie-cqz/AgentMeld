import fs from "node:fs";
import {
  resolveDeploymentFile
} from "@/server/deployment-service";
import { getStaticResponseHeaders } from "@/server/static-file-utils";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; path?: string[] }> }
) {
  const { id, path } = await context.params;
  let filePath: string | null;
  try {
    filePath = resolveDeploymentFile(id, path?.join("/"));
  } catch {
    return new Response("Deployment not found.", { status: 404 });
  }

  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return new Response("Deployment file not found.", { status: 404 });
  }

  const requestedPath = path?.join("/") || "index.html";
  const content = fs.readFileSync(filePath);
  return new Response(new Uint8Array(content), {
    headers: getStaticResponseHeaders(requestedPath)
  });
}
