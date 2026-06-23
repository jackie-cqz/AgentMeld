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
  if (requestedPath.toLowerCase().endsWith(".html")) {
    const html = fs.readFileSync(filePath, "utf-8");
    return new Response(prepareDeploymentText(html, id, requestedPath), {
      headers: getStaticResponseHeaders(requestedPath, { allowSameOrigin: true })
    });
  }

  if (isDeploymentTextFile(requestedPath)) {
    const text = fs.readFileSync(filePath, "utf-8");
    return new Response(rewriteRootAbsoluteReferences(text, id), {
      headers: getStaticResponseHeaders(requestedPath)
    });
  }

  const content = fs.readFileSync(filePath);
  return new Response(new Uint8Array(content), {
    headers: getStaticResponseHeaders(requestedPath)
  });
}

function prepareDeploymentText(original: string, deploymentId: string, requestedPath: string) {
  return injectDeploymentBase(
    rewriteRootAbsoluteReferences(original, deploymentId),
    deploymentId,
    requestedPath
  );
}

function injectDeploymentBase(original: string, deploymentId: string, requestedPath: string) {
  const entrySegments = requestedPath.split("/");
  entrySegments.pop();
  const entryDirectory = entrySegments.length > 0
    ? `${entrySegments.map(encodeURIComponent).join("/")}/`
    : "";
  const baseTag = `<base href="/deployments/${encodeURIComponent(deploymentId)}/${entryDirectory}">`;

  if (/<base\s/i.test(original)) {
    return original;
  }
  if (/<head[\s>]/i.test(original)) {
    return original.replace(/<head([^>]*)>/i, `<head$1>\n${baseTag}`);
  }
  if (/<html[\s>]/i.test(original)) {
    return original.replace(/<html([^>]*)>/i, `<html$1>\n<head>${baseTag}</head>`);
  }

  return `<!doctype html>
<html lang="en">
<head>
${baseTag}
</head>
<body>
${original}
</body>
</html>`;
}

function isDeploymentTextFile(fileName: string) {
  return /\.(css|js|mjs|cjs|svg|json|webmanifest)$/i.test(fileName);
}

function rewriteRootAbsoluteReferences(original: string, deploymentId: string) {
  const base = `/deployments/${encodeURIComponent(deploymentId)}`;
  return original
    .replace(
      /(\b(?:src|href|action|poster)\s*=\s*["'])\/(?!\/|deployments\/|api\/|_next\/)([^"']*)/gi,
      (_match, prefix: string, target: string) => `${prefix}${base}/${target}`
    )
    .replace(
      /url\(\s*(["']?)\/(?!\/|deployments\/|api\/|_next\/)([^"')]+)\1\s*\)/gi,
      (_match, quote: string, target: string) => `url(${quote}${base}/${target}${quote})`
    )
    .replace(
      /(["'`])\/((?:assets|static|img|images|fonts)\/[^"'`\\]+)\1/g,
      (_match, quote: string, target: string) => `${quote}${base}/${target}${quote}`
    );
}
