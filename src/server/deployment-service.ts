import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "@/db/client";
import { getArtifact } from "@/server/repositories";
import { getSettings } from "@/server/settings-service";
import { resolveStaticFilePath } from "@/server/static-file-utils";
import { isPathWithin } from "@/server/workspace-utils";
import { PRIVATE_DEPLOYMENT_DIR } from "@/shared/constants";
import type { DeployStatusRecord } from "@/shared/types";

export function deployArtifact(artifactId: string, conversationId: string): DeployStatusRecord {
  try {
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
    const deployDir = getDeploymentDir(deploymentId);
    fs.mkdirSync(deployDir, { recursive: true });

    const webContent = artifact.content as { type: "web_app"; files: Record<string, string>; entry: string };
    for (const [fileName, content] of Object.entries(webContent.files)) {
      const filePath = resolveStaticFilePath(deployDir, fileName);
      if (!filePath) {
        throw new Error(`Artifact contains unsafe deployment file path "${fileName}".`);
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");
    }

    return finalizeDeployment({
      deploymentId,
      deployDir,
      artifactId: artifact.id,
      title: artifact.title,
      version: artifact.version,
      sourceType: "artifact"
    });
  } catch (error) {
    return failedDeploy(
      artifactId,
      error instanceof Error ? error.message : "Artifact deployment failed."
    );
  }
}

export function deployWorkspace(
  workspacePath: string,
  targetPath: string,
  title?: string
): DeployStatusRecord {
  try {
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
    const deployDir = getDeploymentDir(deploymentId);
    fs.mkdirSync(deployDir, { recursive: true });

    copyDir(absPath, deployDir, { maxFiles: 2000, maxBytes: 100 * 1024 * 1024 });

    return finalizeDeployment({
      deploymentId,
      deployDir,
      artifactId: `workspace:${targetPath}`,
      title: title ?? path.basename(targetPath),
      version: 0,
      sourceType: "workspace",
      workspacePath: targetPath
    });
  } catch (error) {
    return failedDeploy(
      "workspace",
      error instanceof Error ? error.message : "Workspace deployment failed."
    );
  }
}

interface FinalizeDeploymentInput {
  deploymentId: string;
  deployDir: string;
  artifactId: string;
  title: string;
  version: number;
  sourceType: "artifact" | "workspace";
  workspacePath?: string;
}

function finalizeDeployment(input: FinalizeDeploymentInput): DeployStatusRecord {
  const settings = getSettings();
  const localPreviewPath = `/deployments/${input.deploymentId}`;
  const base: DeployStatusRecord = {
    id: input.deploymentId,
    artifactId: input.artifactId,
    title: input.title,
    version: input.version,
    previewPath: localPreviewPath,
    status: "ready",
    sourceType: input.sourceType,
    workspacePath: input.workspacePath,
    deploymentType: "local_static",
    deploymentPath: localPreviewPath,
    localPreviewPath,
    summaryInstruction: `Use the deployment preview path exactly as returned: ${localPreviewPath}.`,
    createdAt: Date.now()
  };

  if (!settings.deploymentPublishEnabled) return base;

  const publishRoot = validatePublishRoot(settings.deploymentPublishDir);
  const publicUrl = buildPublicDeploymentUrl(
    settings.deploymentPublicBaseUrl,
    input.deploymentId
  );
  const publishPath = path.resolve(publishRoot, input.deploymentId);
  if (!isPathWithin(publishPath, publishRoot) || publishPath === publishRoot) {
    throw new Error("Deployment publish path is outside the configured publish directory.");
  }

  fs.mkdirSync(publishRoot, { recursive: true });
  if (fs.existsSync(publishPath) && fs.lstatSync(publishPath).isSymbolicLink()) {
    throw new Error("Deployment publish path must not be a symbolic link.");
  }
  fs.mkdirSync(publishPath, { recursive: true });
  copyDir(input.deployDir, publishPath, { maxFiles: 2000, maxBytes: 100 * 1024 * 1024 });

  return {
    ...base,
    previewPath: publicUrl,
    deploymentType: "external_static",
    publicUrl,
    publishPath,
    publishTargetType: "static_directory",
    summaryInstruction: `Use the published URL exactly as returned: ${publicUrl}. The local fallback is ${localPreviewPath}.`
  };
}

export function getDeploymentDir(deploymentId: string): string {
  if (!/^dep_[a-zA-Z0-9_-]+$/.test(deploymentId)) {
    throw new Error("Invalid deployment id.");
  }
  return path.join(getDataDir(), "deployments", deploymentId);
}

export function resolveDeploymentFile(
  deploymentId: string,
  requestedPath?: string
): string | null {
  const relativePath = requestedPath || "index.html";
  if (
    relativePath === PRIVATE_DEPLOYMENT_DIR ||
    relativePath.startsWith(`${PRIVATE_DEPLOYMENT_DIR}/`)
  ) {
    return null;
  }
  return resolveStaticFilePath(getDeploymentDir(deploymentId), relativePath);
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

function validatePublishRoot(configuredPath: string | null): string {
  if (!configuredPath?.trim()) {
    throw new Error("External publishing is enabled, but no publish directory is configured.");
  }

  const publishRoot = path.resolve(configuredPath.trim());
  const parsed = path.parse(publishRoot);
  if (!path.isAbsolute(configuredPath.trim()) || publishRoot === parsed.root) {
    throw new Error("Deployment publish directory must be an absolute non-root directory.");
  }

  const normalized = process.platform === "win32" ? publishRoot.toLowerCase() : publishRoot;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const forbidden = [
    home ? path.join(home, ".ssh") : "",
    process.platform === "win32" ? process.env.WINDIR ?? "C:\\Windows" : "/etc",
    process.platform === "win32" ? process.env.ProgramFiles ?? "C:\\Program Files" : "/usr",
    process.platform === "win32" ? process.env.ProgramData ?? "C:\\ProgramData" : "/var"
  ].filter(Boolean).map((item) => process.platform === "win32" ? path.resolve(item).toLowerCase() : path.resolve(item));

  if (forbidden.some((item) => normalized === item || normalized.startsWith(item + path.sep))) {
    throw new Error("Deployment publish directory points to a protected system location.");
  }

  return publishRoot;
}

function buildPublicDeploymentUrl(baseUrl: string | null, deploymentId: string): string {
  if (!baseUrl?.trim()) {
    throw new Error("External publishing is enabled, but no public base URL is configured.");
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new Error("Deployment public base URL is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Deployment public base URL must use http or https.");
  }

  return `${parsed.toString().replace(/\/+$/, "")}/${deploymentId}/`;
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
        const content = fs.readFileSync(entryPath);
        if (fileCount + 1 > limits.maxFiles) {
          throw new Error(`Deployment exceeds the ${limits.maxFiles} file limit.`);
        }
        if (byteCount + content.length > limits.maxBytes) {
          throw new Error(`Deployment exceeds the ${limits.maxBytes} byte limit.`);
        }
        fileCount++;
        byteCount += content.length;
        fs.writeFileSync(path.join(destDir, entry.name), content);
      }
    }
  }
}
