import fs from "node:fs";
import path from "node:path";
import { getDataDir, getDatabase } from "@/db/client";
import { createArtifact, getArtifact, listArtifacts } from "@/server/repositories";
import { resolveStaticFilePath } from "@/server/static-file-utils";
import { newArtifactId } from "@/shared/ids";
import type { Artifact, ArtifactContent, ArtifactType } from "@/shared/types";

interface CreateArtifactInput {
  conversationId: string;
  createdByAgentId?: string | null;
  type: ArtifactType;
  title: string;
  content: ArtifactContent;
}

interface UpdateArtifactInput {
  title?: string;
  content?: ArtifactContent;
}

export interface ArtifactVersionFamily {
  rootId: string;
  currentId: string;
  latestId: string;
  versions: Artifact[];
}

export function getArtifactById(artifactId: string): Artifact | null {
  return getArtifact(artifactId);
}

export function getArtifactsForConversation(conversationId: string): Artifact[] {
  return listArtifacts(conversationId);
}

export function getAllArtifacts(): Artifact[] {
  // listArtifacts requires a conversationId; iterate over all conversations.
  // For now, we get artifacts through the bootstrap payload.
  // This is a convenience wrapper for the global artifact library.
  const conversations = getConversationIds();
  const all: Artifact[] = [];
  for (const id of conversations) {
    all.push(...listArtifacts(id));
  }
  all.sort((a, b) => b.updatedAt - a.updatedAt);
  return all;
}

function getConversationIds(): string[] {
  try {
    const rows = getDatabase()
      .prepare("SELECT id FROM conversations")
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  } catch {
    return [];
  }
}

export function createNewArtifact(input: CreateArtifactInput): Artifact {
  const artifact = createArtifact({
    id: newArtifactId(),
    conversationId: input.conversationId,
    createdByAgentId: input.createdByAgentId ?? null,
    type: input.type,
    title: input.title,
    content: input.content,
    version: 1,
    parentArtifactId: null,
    now: Date.now()
  });
  return artifact;
}

export function createNewArtifactVersion(artifactId: string, input: UpdateArtifactInput): Artifact | null {
  const existing = getArtifact(artifactId);
  if (!existing) return null;

  const content = input.content ?? existing.content;
  const title = input.title ?? existing.title;

  return createArtifact({
    id: newArtifactId(),
    conversationId: existing.conversationId,
    createdByAgentId: existing.createdByAgentId,
    type: existing.type,
    title,
    content,
    version: existing.version + 1,
    parentArtifactId: existing.id,
    now: Date.now()
  });
}

export function getVersionChain(artifactId: string): Artifact[] {
  const chain: Artifact[] = [];
  let current = getArtifact(artifactId);
  while (current) {
    chain.push(current);
    if (!current.parentArtifactId) break;
    current = getArtifact(current.parentArtifactId);
  }
  return chain;
}

export function getLatestVersion(artifactId: string): Artifact | null {
  return getArtifactVersionFamily(artifactId)?.versions.at(-1) ?? null;
}

export function getArtifactVersionFamily(artifactId: string): ArtifactVersionFamily | null {
  const current = getArtifact(artifactId);
  if (!current) return null;

  const artifacts = listArtifacts(current.conversationId);
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  let root = current;
  const visited = new Set<string>();

  while (root.parentArtifactId && !visited.has(root.id)) {
    visited.add(root.id);
    const parent = artifactsById.get(root.parentArtifactId);
    if (!parent) break;
    root = parent;
  }

  const belongsToFamily = (artifact: Artifact): boolean => {
    let candidate: Artifact | undefined = artifact;
    const candidateVisited = new Set<string>();
    while (candidate && !candidateVisited.has(candidate.id)) {
      if (candidate.id === root.id) return true;
      candidateVisited.add(candidate.id);
      candidate = candidate.parentArtifactId
        ? artifactsById.get(candidate.parentArtifactId)
        : undefined;
    }
    return false;
  };

  const versions = artifacts
    .filter(belongsToFamily)
    .sort((left, right) =>
      left.version - right.version ||
      left.createdAt - right.createdAt ||
      left.id.localeCompare(right.id)
    );

  return {
    rootId: root.id,
    currentId: current.id,
    latestId: versions.at(-1)?.id ?? current.id,
    versions
  };
}

export function getWebAppPreviewDir(artifactId: string): string {
  return path.join(getDataDir(), "previews", artifactId);
}

export function ensureWebAppPreview(artifact: Artifact): string {
  if (artifact.type !== "web_app") {
    throw new Error("Artifact is not a web_app.");
  }

  const webContent = artifact.content as Extract<ArtifactContent, { type: "web_app" }>;
  const previewDir = getWebAppPreviewDir(artifact.id);
  if (!fs.existsSync(previewDir)) {
    fs.mkdirSync(previewDir, { recursive: true });
    for (const [fileName, content] of Object.entries(webContent.files)) {
      const filePath = resolveStaticFilePath(previewDir, fileName);
      if (!filePath) {
        throw new Error(`Web app artifact "${artifact.id}" contains unsafe file path "${fileName}".`);
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, String(content), "utf-8");
    }
  }

  return previewDir;
}
