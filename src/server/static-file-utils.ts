import path from "node:path";
import { isPathWithin } from "@/server/workspace-utils";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

export function normalizeStaticFilePath(input: string): string | null {
  const normalized = input.replaceAll("\\", "/").trim();
  if (!normalized || normalized.includes("\0")) return null;
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) return null;

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }

  return segments.join("/");
}

export function resolveStaticFilePath(rootDir: string, input: string): string | null {
  const normalized = normalizeStaticFilePath(input);
  if (!normalized) return null;

  const resolved = path.resolve(rootDir, ...normalized.split("/"));
  return isPathWithin(resolved, rootDir) ? resolved : null;
}

export function getStaticMimeType(fileName: string): string {
  return MIME_TYPES[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

export function getStaticResponseHeaders(
  fileName: string,
  options: { allowSameOrigin?: boolean } = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "Content-Type": getStaticMimeType(fileName),
    "X-Content-Type-Options": "nosniff"
  };

  if (path.extname(fileName).toLowerCase() === ".html") {
    const sandboxPolicy = options.allowSameOrigin
      ? "sandbox allow-scripts allow-same-origin"
      : "sandbox allow-scripts";
    headers["Content-Security-Policy"] =
      `${sandboxPolicy}; default-src 'self' data: blob: https:; script-src 'unsafe-inline' 'self' blob: https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https:;`;
  }

  return headers;
}
