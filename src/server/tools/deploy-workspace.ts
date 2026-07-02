import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createNewArtifact } from "@/server/artifact-service";
import { deployWorkspace } from "@/server/deployment-service";
import type { ToolDef } from "@/server/tools/types";
import { isPathWithin } from "@/server/workspace-utils";

const TEXT_FILE_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".txt",
  ".md",
  ".svg",
  ".xml",
  ".webmanifest",
  ".map"
]);

const MAX_ARTIFACT_TEXT_FILES = 200;
const MAX_ARTIFACT_TEXT_FILE_BYTES = 512 * 1024;
const MAX_ARTIFACT_TEXT_TOTAL_BYTES = 4 * 1024 * 1024;

export const deployWorkspaceTool: ToolDef = {
  name: "deploy_workspace",
  description:
    "Deploy a static directory from the workspace. The directory must contain an index.html. Use after running build commands.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Path relative to workspace root." },
      title: { type: "string", description: "Optional deployment title." }
    }
  },
  async handler(args, ctx) {
    const parsed = z.object({
      path: z.string().min(1),
      title: z.string().optional()
    }).safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` };
    }

    const result = deployWorkspace(ctx.workspacePath, parsed.data.path, parsed.data.title);
    if (result.status !== "ready") {
      return { ok: true, value: result };
    }

    const workspaceDistPath = path.resolve(ctx.workspacePath, parsed.data.path);
    const files = collectTextArtifactFiles(workspaceDistPath, ctx.workspacePath);
    const artifact = createNewArtifact({
      conversationId: ctx.conversationId,
      createdByAgentId: ctx.agentId,
      type: "web_app",
      title: result.title,
      content: {
        type: "web_app",
        files,
        entry: files["index.html"] ? "index.html" : Object.keys(files)[0] ?? "index.html",
        deploymentPreviewPath: result.previewPath,
        sourceType: "workspace"
      }
    });

    return {
      ok: true,
      value: {
        ...result,
        artifactId: artifact.id,
        version: artifact.version
      }
    };
  }
};

function collectTextArtifactFiles(rootPath: string, workspacePath: string): Record<string, string> {
  if (!isPathWithin(rootPath, workspacePath)) {
    return fallbackWorkspaceArtifactFiles("Workspace path is outside the active workspace.");
  }

  const files: Record<string, string> = {};
  let fileCount = 0;
  let totalBytes = 0;
  const stack = [rootPath];

  while (stack.length > 0 && fileCount < MAX_ARTIFACT_TEXT_FILES && totalBytes < MAX_ARTIFACT_TEXT_TOTAL_BYTES) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = normalizeArtifactPath(path.relative(rootPath, absolutePath));
      if (!relativePath || shouldSkipWorkspaceArtifactPath(relativePath, entry.name)) continue;

      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || !isTextArtifactFile(relativePath)) continue;

      const stats = fs.statSync(absolutePath);
      if (stats.size > MAX_ARTIFACT_TEXT_FILE_BYTES) continue;
      if (totalBytes + stats.size > MAX_ARTIFACT_TEXT_TOTAL_BYTES) break;

      const content = fs.readFileSync(absolutePath, "utf-8");
      if (content.includes("\u0000")) continue;
      files[relativePath] = content;
      fileCount++;
      totalBytes += stats.size;
    }
  }

  return Object.keys(files).length > 0
    ? sortFilesWithIndexFirst(files)
    : fallbackWorkspaceArtifactFiles("No text files could be copied into the artifact record.");
}

function normalizeArtifactPath(value: string) {
  return value.replaceAll(path.sep, "/");
}

function shouldSkipWorkspaceArtifactPath(relativePath: string, entryName: string) {
  return (
    relativePath.startsWith("../") ||
    relativePath.includes("/../") ||
    relativePath.startsWith(".git/") ||
    relativePath.startsWith("node_modules/") ||
    entryName === ".git" ||
    entryName === "node_modules" ||
    (entryName.startsWith(".") && entryName !== ".well-known")
  );
}

function isTextArtifactFile(relativePath: string) {
  return TEXT_FILE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function sortFilesWithIndexFirst(files: Record<string, string>) {
  const sorted: Record<string, string> = {};
  if (files["index.html"] !== undefined) {
    sorted["index.html"] = files["index.html"];
  }
  for (const key of Object.keys(files).sort()) {
    if (key !== "index.html") sorted[key] = files[key];
  }
  return sorted;
}

function fallbackWorkspaceArtifactFiles(reason: string): Record<string, string> {
  return {
    "README.md": [
      "# Workspace deployment",
      "",
      reason,
      "The runnable preview is served from the deployment snapshot."
    ].join("\n")
  };
}
