import fs from "node:fs";
import { eventBus } from "@/server/event-bus";
import { getChannelConversationByConversationId, getWorkspaceForConversation } from "@/server/repositories";
import { getFeishuChannelForAgent } from "@/server/channels/feishu/registry";
import { resolveSafePath } from "@/server/workspace-utils";
import { isChannelProjectionPaused, withinSendBudget } from "@/server/channels/feishu/projection";
import type { Artifact } from "@/shared/types";

/**
 * Deliver an artifact into the room as a file.
 *
 * This is the answer to a problem this design had recorded as unsolvable. §5.6
 * wanted an entry point to the artifact and §7.3 said it could not have one,
 * because an artifact is stored locally and a chat member has no route to it —
 * the local-first versus publicly-reachable contradiction. It turns out the
 * platform will accept an upload with the scopes a one-click app already has
 * (verified against the live API, because the last time a scope was assumed
 * present it was not). A file needs no URL, so the contradiction simply does
 * not apply to this route.
 *
 * Types that are a set of files (a web app) or a structure (a deck, a diff) are
 * NOT delivered here — sending one file out of a set would be worse than
 * sending nothing. They keep the reference the message projection writes, and
 * the reason is stated rather than left to look like an oversight.
 */

export interface ArtifactFile {
  name: string;
  content: Buffer;
}

/** A filename a chat can display safely. */
function safeFileName(title: string, fallback: string, extension: string): string {
  const base = (title || fallback)
    .replace(/[/\\]/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, "")
    .trim()
    .slice(0, 80);
  return `${base || fallback}${extension}`;
}

/**
 * The bytes to send, or why this artifact cannot be sent as one file.
 *
 * Pure apart from reading a workspace file, so the decision is testable without
 * a platform round trip.
 */
export function artifactFileFor(
  artifact: Artifact,
  workspaceRoot: string | null
): ArtifactFile | { reason: string } {
  const content = artifact.content;

  if (content.type === "document") {
    return {
      name: safeFileName(artifact.title, "artifact", ".md"),
      content: Buffer.from(content.content, "utf-8")
    };
  }

  if (content.type === "code_file") {
    if (!workspaceRoot) return { reason: "the conversation has no workspace" };
    try {
      // Through the same guard the file browser uses: a stored path is not a
      // reason to trust it.
      const absolute = resolveSafePath(workspaceRoot, content.workspacePath);
      const body = fs.readFileSync(absolute);
      const name = safeFileName(
        artifact.title,
        content.workspacePath.split("/").pop() ?? "file",
        ""
      );
      return { name, content: body };
    } catch {
      return { reason: "the file is no longer on disk" };
    }
  }

  if (content.type === "web_app") {
    return {
      reason: "a web app is a set of files, and this would send only one of them"
    };
  }

  return { reason: `a ${content.type} artifact has no single file to send` };
}

export type DeliveryOutcome =
  | { status: "delivered"; chatId: string; fileName: string }
  | { status: "skipped"; reason: string };

export async function projectArtifact(artifact: Artifact): Promise<DeliveryOutcome> {
  if (isChannelProjectionPaused()) return { status: "skipped", reason: "paused" };

  const channelConversation = getChannelConversationByConversationId(artifact.conversationId);
  if (!channelConversation) return { status: "skipped", reason: "conversation is not on a channel" };

  // An artifact may have no author — one can be produced by a step rather than
  // an agent — and in that case there is no bot that could hand it over.
  const agentId = artifact.createdByAgentId;
  if (!agentId) return { status: "skipped", reason: "the artifact has no author" };

  const channel = getFeishuChannelForAgent(agentId);
  if (!channel) return { status: "skipped", reason: "agent has no live channel" };

  const workspace = getWorkspaceForConversation(artifact.conversationId);
  const file = artifactFileFor(artifact, workspace?.rootPath ?? null);
  if ("reason" in file) return { status: "skipped", reason: file.reason };

  // The rate limit applies: an agent that writes ten files should not turn the
  // room into a file dump.
  if (!withinSendBudget(artifact.conversationId, Date.now())) {
    return { status: "skipped", reason: "send budget exhausted" };
  }

  const sent = await channel.send(channelConversation.chatId, {
    file: { source: file.content, fileName: file.name }
  });
  console.info(
    `[feishu] delivered ${file.name} (${file.content.length} bytes) to ${channelConversation.chatId} (${sent.messageId})`
  );
  return { status: "delivered", chatId: channelConversation.chatId, fileName: file.name };
}

declare global {
  var __agentMeldChannelArtifactStop: (() => void) | undefined;
}

/**
 * Follow artifact creation.
 *
 * Subscribes once per process. An artifact is announced when it is created,
 * which is also when the agent that made it is still around to hand it over.
 */
export function startChannelArtifactDelivery(): () => void {
  if (globalThis.__agentMeldChannelArtifactStop) return globalThis.__agentMeldChannelArtifactStop;

  const stop = eventBus.subscribe((entry) => {
    if (entry.event.type !== "artifact.create") return;
    void projectArtifact(entry.event.artifact).catch((error: unknown) => {
      console.error("[feishu] failed to deliver an artifact:", error);
    });
  });

  globalThis.__agentMeldChannelArtifactStop = stop;
  return stop;
}

export function stopChannelArtifactDeliveryForTests(): void {
  globalThis.__agentMeldChannelArtifactStop?.();
  globalThis.__agentMeldChannelArtifactStop = undefined;
}
