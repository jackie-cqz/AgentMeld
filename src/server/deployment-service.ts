import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "@/db/client";
import { getArtifact } from "@/server/repositories";
import { newMessageId } from "@/shared/ids";
import type { DeployStatusRecord } from "@/shared/types";

export function deployArtifact(artifactId: string, conversationId: string): DeployStatusRecord {
  const artifact = getArtifact(artifactId);
  if (!artifact) {
    return failedDeploy(artifactId, "Artifact not found.");
  }
  if (artifact.conversationId !== conversationId) {
    return failedDeploy(artifactId, "Artifact does not belong to this conversation.");
  }
  if (artifact.type !== "web_app") {
    return failedDeploy(artifactId, `Artifact type "${artifact.type}" cannot be deployed as a web app.`);
  }

  const deploymentId = `dep_${artifactId}`;
  const deployDir = path.join(getDataDir(), "deployments", deploymentId);
  fs.mkdirSync(deployDir, { recursive: true });

  const webContent = artifact.content as { type: "web_app"; files: Record<string, string>; entry: string };
  for (const [fileName, content] of Object.entries(webContent.files)) {
    const safeName = path.basename(fileName);
    fs.writeFileSync(path.join(deployDir, safeName), content, "utf-8");
  }

  return {
    id: deploymentId,
    artifactId: artifact.id,
    title: artifact.title,
    version: artifact.version,
    previewPath: `/deployments/${deploymentId}`,
    status: "ready",
    sourceType: "artifact",
    deploymentType: "local_static",
    sourceDownloadPath: `/api/deployments/${deploymentId}/download/source`,
    createdAt: Date.now()
  };
}

export function deployWorkspace(
  workspacePath: string,
  targetPath: string,
  title?: string
): DeployStatusRecord {
  const absPath = path.resolve(workspacePath, targetPath);

  if (!isPathWithin(absPath, workspacePath)) {
    return failedDeploy("workspace", "Path is outside workspace.");
  }

  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
    return failedDeploy("workspace", "Path is not a directory.");
  }

  const entryFile = path.join(absPath, "index.html");
  if (!fs.existsSync(entryFile)) {
    return failedDeploy("workspace", "Directory does not contain index.html.");
  }

  const deploymentId = `dep_ws_${Date.now()}`;
  const deployDir = path.join(getDataDir(), "deployments", deploymentId);
  fs.mkdirSync(deployDir, { recursive: true });

  // Copy static files
  copyDir(absPath, deployDir, { maxFiles: 2000, maxBytes: 100 * 1024 * 1024 });

  return {
    id: deploymentId,
    artifactId: `workspace:${targetPath}`,
    title: title ?? path.basename(targetPath),
    version: 0,
    previewPath: `/deployments/${deploymentId}`,
    status: "ready",
    sourceType: "workspace",
    workspacePath: targetPath,
    deploymentType: "local_static",
    sourceDownloadPath: `/api/deployments/${deploymentId}/download/source`,
    createdAt: Date.now()
  };
}

function failedDeploy(id: string, error: string): DeployStatusRecord {
  return {
    id: `dep_failed_${Date.now()}`,
    artifactId: id,
    title: "Deployment Failed",
    version: 0,
    previewPath: "",
    status: "failed",
    error,
    createdAt: Date.now()
  };
}

function isPathWithin(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

function copyDir(
  src: string,
  dest: string,
  limits: { maxFiles: number; maxBytes: number }
): void {
  let fileCount = 0;
  let byteCount = 0;

  const stack = [src];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const relPath = path.relative(src, current);
    const destDir = path.join(dest, relPath);
    fs.mkdirSync(destDir, { recursive: true });

    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      // Skip hidden/private dirs
      if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;

      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        if (fileCount >= limits.maxFiles) break;
        if (byteCount >= limits.maxBytes) break;

        const content = fs.readFileSync(entryPath);
        fileCount++;
        byteCount += content.length;
        fs.writeFileSync(path.join(destDir, entry.name), content);
      }
    }
  }
}
