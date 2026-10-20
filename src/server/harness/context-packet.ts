import fs from "node:fs";
import path from "node:path";
import { getAttachment } from "@/server/attachment-service";
import { assertRealPathWithinWorkspace } from "@/server/workspace-utils";
import type { ChatMessage } from "@/server/conversation-context";
import type { Message } from "@/shared/types";
import type { HarnessContextAttachment, HarnessContextPacket } from "./types";

export interface BuildHarnessContextPacketInput {
  conversationId: string;
  /** Physical workspace root the platform resolved for this invocation. */
  workspaceRoot: string;
  parentRunId?: string | null;
  /**
   * Authoritative current-task text already compiled by the platform. When
   * omitted, the trigger message's text parts are used.
   */
  task?: string;
  triggerMessage: Message;
  /** Prior context the platform chose to include; dropped for delegated work. */
  history?: ChatMessage[];
}

/**
 * Decide what context a run gets, in platform terms (#25 P2).
 *
 * The platform owns the decision: the authoritative task text, whether prior
 * conversation history is relevant (never for delegated work), and which
 * attachment references this conversation/workspace authorized. Serialization —
 * the XML envelope Pi expects — is the driver's job (`src/server/pi/packet.ts`).
 */
export function buildHarnessContextPacket(input: BuildHarnessContextPacketInput): HarnessContextPacket {
  const task = input.task ?? input.triggerMessage.parts
    .filter(part => part.type === "text")
    .map(part => part.content)
    .join("\n");
  return {
    task,
    priorHistory: input.parentRunId ? [] : [...(input.history ?? [])],
    attachments: resolveAttachments(input),
  };
}

function resolveAttachments(input: BuildHarnessContextPacketInput): HarnessContextAttachment[] {
  return input.triggerMessage.parts.flatMap(part => {
    if (part.type !== "file_attachment" && part.type !== "image_attachment") return [];
    const attachment = getAttachment(part.attachmentId);
    if (!attachment || attachment.conversationId !== input.conversationId) return [];
    let workspacePath: string | undefined;
    try {
      workspacePath = path.relative(input.workspaceRoot, assertRealPathWithinWorkspace(input.workspaceRoot, fs.realpathSync.native(attachment.filePath)));
    } catch {
      // Out-of-workspace attachments are only accessible through the scoped
      // platform tool; the packet still names the attachment but no path.
    }
    return [{ id: attachment.id, fileName: attachment.fileName, mimeType: attachment.mimeType, workspacePath }];
  });
}
