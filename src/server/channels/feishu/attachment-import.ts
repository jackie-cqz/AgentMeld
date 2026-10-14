import fs from "node:fs";
import path from "node:path";
import { getDatabase } from "@/db/client";
import { getWorkspaceForConversation } from "@/server/repositories";
import { newAttachmentId } from "@/shared/ids";
import { getFeishuChannelForAgent } from "@/server/channels/feishu/registry";

/**
 * Bring files a person attached in the chat into the conversation.
 *
 * Without this, sending a file to the bot does nothing at all — no error, no
 * record, nothing the agent can use. The platform keeps the bytes behind a key
 * and a message id; fetching them is a decision this makes rather than something
 * the transport does for every message.
 *
 * Files land where the web uploader puts them — `<workspace>/attachments` — so
 * the agent sees one convention regardless of which door the file came through,
 * and they are recorded as attachments so the ordinary message pipeline renders
 * and resolves them.
 */

/** Beyond this, a file is recorded as skipped rather than pulled into memory. */
const MAX_RESOURCE_BYTES = 30 * 1024 * 1024;
/** A message with more attachments than this is not going to be read anyway. */
const MAX_RESOURCES = 10;

export interface InboundResource {
  type: string;
  fileKey: string;
  fileName: string | null;
}

export type ResourceImportOutcome =
  | { status: "imported"; attachmentIds: string[]; skipped: string[] }
  | { status: "skipped"; reason: string };

/** A filename a filesystem can take, without letting a name suggest a path. */
export function safeAttachmentName(fileName: string | null, fallback: string): string {
  const base = (fileName ?? "")
    .replace(/[/\\]/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, "")
    .trim()
    .slice(0, 120);
  if (!base || base === "." || base === "..") return fallback;
  return base;
}

function kindFor(fileName: string): "image" | "file" {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(fileName) ? "image" : "file";
}

function mimeFor(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  const known: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".csv": "text/csv",
    ".zip": "application/zip"
  };
  return known[extension] ?? "application/octet-stream";
}

export async function importInboundResources(input: {
  agentId: string;
  conversationId: string;
  platformMessageId: string;
  resources: InboundResource[];
  now?: number;
}): Promise<ResourceImportOutcome> {
  if (input.resources.length === 0) return { status: "skipped", reason: "no attachments" };

  // The download is made as the bot that received the message: the platform
  // scopes a resource to the app that was sent it.
  const channel = getFeishuChannelForAgent(input.agentId);
  if (!channel) return { status: "skipped", reason: "agent has no live channel" };

  const workspace = getWorkspaceForConversation(input.conversationId);
  if (!workspace) return { status: "skipped", reason: "the conversation has no workspace" };

  const attachDir = path.join(workspace.rootPath, "attachments");
  fs.mkdirSync(attachDir, { recursive: true });

  const now = input.now ?? Date.now();
  const attachmentIds: string[] = [];
  const skipped: string[] = [];

  for (const [index, resource] of input.resources.slice(0, MAX_RESOURCES).entries()) {
    const fileName = safeAttachmentName(resource.fileName, `attachment-${index + 1}`);
    try {
      const body = await channel.downloadResource(
        input.platformMessageId,
        resource.fileKey,
        resource.type as never
      );
      if (body.length > MAX_RESOURCE_BYTES) {
        // Recorded as skipped rather than silently dropped: a file that never
        // arrived is different from one that was never sent.
        skipped.push(`${fileName}（超过大小上限）`);
        continue;
      }

      const id = newAttachmentId();
      const filePath = path.join(attachDir, `${id}-${fileName}`);
      fs.writeFileSync(filePath, body);

      getDatabase()
        .prepare(
          `INSERT INTO attachments (id, conversation_id, kind, file_name, file_path, size, mime_type, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.conversationId, kindFor(fileName), fileName, filePath, body.length, mimeFor(fileName), now);

      attachmentIds.push(id);
    } catch (error) {
      skipped.push(`${fileName}（下载失败）`);
      console.error(`[feishu] failed to fetch an attachment: ${fileName}`, error);
    }
  }

  if (input.resources.length > MAX_RESOURCES) {
    skipped.push(`另有 ${input.resources.length - MAX_RESOURCES} 个附件未处理`);
  }

  return { status: "imported", attachmentIds, skipped };
}

/**
 * A line telling the room what could not be brought in.
 *
 * Returned rather than logged, so the router can decide how to say it — and so
 * a failure to fetch a file is visible to the people who sent it instead of
 * only to whoever reads the server log.
 */
export function describeSkippedResources(skipped: string[]): string | null {
  if (skipped.length === 0) return null;
  return `⚠️ 有附件没能导入：${skipped.join("、")}`;
}
