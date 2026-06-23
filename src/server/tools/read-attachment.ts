import { z } from "zod";
import { getAttachment, readAttachmentContent } from "@/server/attachment-service";
import type { ToolDef } from "@/server/tools/types";

export const readAttachmentTool: ToolDef = {
  name: "read_attachment",
  description:
    "Read a user-uploaded attachment. For text files, returns the content (up to 50,000 chars). " +
    "For images, returns metadata. For other binary files, returns a note. " +
    "Use this to understand user-provided files and documents.",
  parameters: {
    type: "object",
    required: ["attachmentId"],
    properties: {
      attachmentId: {
        type: "string",
        description: "The attachment ID to read. Must belong to the current conversation."
      }
    }
  },
  async handler(args, ctx) {
    const parsed = z.object({ attachmentId: z.string().min(1) }).safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` };
    }

    // Prevent confusion with artifacts
    if (parsed.data.attachmentId.startsWith("art_")) {
      return { ok: false, error: "This looks like an artifact ID. Use read_artifact instead." };
    }

    const attachment = getAttachment(parsed.data.attachmentId);
    if (!attachment) {
      return { ok: false, error: `Attachment "${parsed.data.attachmentId}" not found.` };
    }
    if (attachment.conversationId !== ctx.conversationId) {
      return { ok: false, error: "Attachment does not belong to the current conversation." };
    }

    const result = readAttachmentContent(attachment);

    if ("note" in result) {
      return {
        ok: true,
        value: {
          id: attachment.id,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          kind: attachment.kind,
          note: result.note
        }
      };
    }

    return {
      ok: true,
      value: {
        id: attachment.id,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        kind: attachment.kind,
        content: result.content,
        truncated: result.truncated
      }
    };
  }
};
