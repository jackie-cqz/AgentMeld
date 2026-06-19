import fs from "node:fs";
import path from "node:path";
import { getWorkspaceForConversation } from "@/server/repositories";
import { resolveStaticFilePath } from "@/server/static-file-utils";

export const dynamic = "force-dynamic";

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

  try {
    // resolveStaticFilePath rejects ".", so handle root directory explicitly
    const resolved = dirPath === "." ? rootPath : resolveStaticFilePath(rootPath, dirPath);
    if (!resolved || !resolved.startsWith(rootPath)) {
      return Response.json({ error: "Invalid path." }, { status: 400 });
    }

    if (readFile) {
      // Read file content
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return Response.json({ error: "Not a file." }, { status: 400 });
      }
      const content = fs.readFileSync(resolved, "utf-8");
      const truncated = content.length > 50000;
      return Response.json({ content: truncated ? content.slice(0, 50000) + "\n...(truncated)" : content, truncated });
    }

    // List directory
    if (!fs.statSync(resolved).isDirectory()) {
      return Response.json({ error: "Not a directory." }, { status: 400 });
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .filter((d) => !d.name.startsWith("."))
      .map((d) => ({
        name: d.name,
        type: d.isDirectory() ? "directory" as const : "file" as const,
        size: d.isFile() ? fs.statSync(path.join(resolved, d.name)).size : undefined
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return Response.json({ entries });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to read workspace." }, { status: 500 });
  }
}
