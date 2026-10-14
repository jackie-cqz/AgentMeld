import fs from "node:fs";
import path from "node:path";
import { getDatabase } from "@/db/client";
import { getWorkspaceForConversation } from "@/server/repositories";
import { newAttachmentId } from "@/shared/ids";
import { getFeishuChannelForAgent } from "@/server/channels/feishu/registry";
import { safeFileName } from "@/server/channels/feishu/file-name";

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
/**
 * The type the SDK will accept.
 *
 * `ResourceDescriptor.type` also carries audio, video and sticker, but the
 * download API takes only 'image' or 'file'. Those are requested as files —
 * which they are for this purpose. A sticker is the exception: the platform
 * does not serve them at all, so asking would only produce an error.
 */
function sdkResourceType(type: string): "image" | "file" | null {
  if (type === "sticker") return null;
  return type === "image" ? "image" : "file";
}

/**
 * Whether this is an image, from the platform's own classification.
 *
 * Not from the filename: the SDK's image resources carry NO `fileName` at all,
 * so inferring from one made every pasted screenshot a generic file.
 */
function kindFor(resourceType: string): "image" | "file" {
  return resourceType === "image" ? "image" : "file";
}

/** The extension implied by the server's content-type, if it names one. */
function extensionForContentType(contentType: string | undefined): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "text/markdown": ".md",
    "text/plain": ".txt",
    "application/json": ".json",
    "text/csv": ".csv",
    "application/zip": ".zip"
  };
  return contentType ? (map[contentType] ?? "") : "";
}

function mimeFor(fileName: string, contentType: string | undefined): string {
  if (contentType) return contentType;
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
    const provisional = safeFileName(resource.fileName, `attachment-${index + 1}`);

    const sdkType = sdkResourceType(resource.type);
    if (!sdkType) {
      skipped.push(`${provisional}（平台不提供此类资源）`);
      continue;
    }

    const id = newAttachmentId();
    // Streamed to disk rather than into a Buffer: `downloadResource` materialises
    // the whole payload, so a size cap checked after it returns has already let
    // the bytes into memory. The SDK's own docs say to prefer this path for
    // anything headed for disk.
    const partPath = path.join(attachDir, `${id}.part`);

    try {
      const { contentType, bytesWritten } = await channel.downloadResourceToFile(
        input.platformMessageId,
        resource.fileKey,
        sdkType,
        partPath
      );

      if (bytesWritten > MAX_RESOURCE_BYTES) {
        // Removed, not kept: the cap already let this much reach the disk, and
        // keeping it would make the cap decorative.
        fs.rmSync(partPath, { force: true });
        skipped.push(`${provisional}（超过大小上限）`);
        continue;
      }

      // The server's content-type names the real type; the filename may be
      // absent entirely (image resources never carry one).
      const withExtension =
        path.extname(provisional) === ""
          ? `${provisional}${extensionForContentType(contentType)}`
          : provisional;
      const fileName = safeFileName(withExtension, `attachment-${index + 1}`);
      const filePath = path.join(attachDir, `${id}-${fileName}`);
      fs.renameSync(partPath, filePath);

      getDatabase()
        .prepare(
          `INSERT INTO attachments (id, conversation_id, kind, file_name, file_path, size, mime_type, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.conversationId,
          kindFor(resource.type),
          fileName,
          filePath,
          bytesWritten,
          mimeFor(fileName, contentType),
          now
        );

      attachmentIds.push(id);
    } catch (error) {
      fs.rmSync(partPath, { force: true });
      skipped.push(`${provisional}（下载失败）`);
      console.error(`[feishu] failed to fetch an attachment: ${provisional}`, error);
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
