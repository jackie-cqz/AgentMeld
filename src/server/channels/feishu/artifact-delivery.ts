import fs from "node:fs";
import { eventBus } from "@/server/event-bus";
import {
  getChannelConversationByConversationId,
  getConversation,
  getWorkspaceForConversation
} from "@/server/repositories";
import { getFeishuChannelForAgent } from "@/server/channels/feishu/registry";
import {
  isChannelProjectionPaused,
  recordSend,
  withinSendBudget
} from "@/server/channels/feishu/projection";
import { MAX_FILE_READ_BYTES, resolveWorkspaceFileForRead } from "@/server/workspace-utils";
import { safeFileName } from "@/server/channels/feishu/file-name";
import type { Artifact, Workspace } from "@/shared/types";
import { deliverSend } from "@/server/channels/feishu/delivery";
import {
  MAX_WEB_APP_BYTES,
  inlineWebApp,
  inlineWebAppName,
  zipWebApp,
  zipWebAppName
} from "@/server/channels/feishu/web-app";

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
 * A web app is a set of files, so it is not sent as one arbitrary file out of
 * the set: it is folded into a single self-contained page when that is
 * faithful, and zipped when it is not (see web-app.ts). Structures that are not
 * files at all — a deck's slides, a diff's hunks — keep the reference the
 * message projection writes, and the reason is stated rather than left to look
 * like an oversight.
 */

export interface ArtifactFile {
  name: string;
  content: Buffer;
}

/**
 * The bytes to send, or why this artifact cannot be sent as one file.
 *
 * Pure apart from reading a workspace file, so the decision is testable without
 * a platform round trip.
 */
export function artifactFileFor(
  artifact: Artifact,
  workspace: Workspace | null
): ArtifactFile | { reason: string } {
  const content = artifact.content;

  if (content.type === "document") {
    return {
      name: safeFileName(artifact.title, "artifact", ".md"),
      content: Buffer.from(content.content, "utf-8")
    };
  }

  if (content.type === "code_file") {
    if (!workspace) return { reason: "the conversation has no workspace" };
    // Through the SAME function the file browser uses, which resolves symlinks
    // and compares real paths. The earlier version used a lexical check and
    // claimed this; a symlink to /etc passed it and its contents were sent.
    const resolved = resolveWorkspaceFileForRead(workspace, content.workspacePath);
    if (!resolved.ok) return { reason: resolved.reason };
    if (resolved.size > MAX_FILE_READ_BYTES) {
      return { reason: `the file is ${resolved.size} bytes, over the ${MAX_FILE_READ_BYTES} limit` };
    }
    const extension = content.workspacePath.includes(".")
      ? `.${content.workspacePath.split(".").pop()}`
      : "";
    return {
      name: safeFileName(
        artifact.title,
        content.workspacePath.split("/").pop() ?? "file",
        extension
      ),
      content: fs.readFileSync(resolved.realPath)
    };
  }

  if (content.type === "image") {
    // An image IS one file, and the earlier refusal ("no single file to send")
    // was simply wrong. Only a data URL is decoded: fetching a URL the model
    // supplied would make this process a request to anywhere it names.
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(content.url);
    if (!match) {
      return { reason: "the image points at a URL, and this will not fetch one" };
    }
    const body = Buffer.from(match[2], "base64");
    const extension = match[1].includes("png")
      ? ".png"
      : match[1].includes("jpeg")
        ? ".jpg"
        : match[1].includes("gif")
          ? ".gif"
          : match[1].includes("webp")
            ? ".webp"
            : ".bin";
    return { name: safeFileName(artifact.title, "image", extension), content: body };
  }

  if (content.type === "web_app") {
    // Malformed content must come back as a reason: this function's contract is
    // "bytes or why", and a thrown TypeError here is swallowed by the
    // subscriber's catch, so the not-delivering log line never appears.
    const files = content.files;
    if (!files || typeof files !== "object") {
      return { reason: "the web app has no file map" };
    }
    const fileNames = Object.keys(files);
    if (fileNames.length === 0) {
      return { reason: "the web app has no files" };
    }

    // A cheap pre-check before any building: the precise ceiling is on the
    // DELIVERED bytes below, but there is no reason to assemble a 40 MB input
    // (folding and zipping both build the whole thing in memory) only to
    // reject it afterwards.
    const sourceBytes = fileNames.reduce(
      (sum, name) => sum + Buffer.byteLength(typeof files[name] === "string" ? files[name] : "", "utf-8"),
      0
    );
    if (sourceBytes > MAX_WEB_APP_BYTES) {
      return { reason: `the web app is ${sourceBytes} bytes, over the ${MAX_WEB_APP_BYTES} limit` };
    }

    // A single-page app with text assets becomes ONE self-contained HTML file,
    // which is what "meant to be opened in a browser" actually needs. Anything
    // else is delivered as a zip so the set stays whole (see web-app.ts).
    const inlined = inlineWebApp(files, content.entry);
    if (inlined.ok) {
      const bytes = Buffer.from(inlined.html, "utf-8");
      // The ceiling applies to what is DELIVERED, not to the source bytes: a
      // zip adds per-entry overhead and could otherwise exceed it.
      if (bytes.length > MAX_WEB_APP_BYTES) {
        return { reason: `the folded page is ${bytes.length} bytes, over the ${MAX_WEB_APP_BYTES} limit` };
      }
      return { name: inlineWebAppName(artifact.title), content: bytes };
    }

    try {
      const zipped = zipWebApp(files);
      if (zipped.length > MAX_WEB_APP_BYTES) {
        return { reason: `the packaged web app is ${zipped.length} bytes, over the ${MAX_WEB_APP_BYTES} limit` };
      }
      return { name: zipWebAppName(artifact.title), content: zipped };
    } catch (error) {
      return {
        reason: error instanceof Error ? error.message : "the web app could not be packaged"
      };
    }
  }

  return { reason: `a ${content.type} artifact is not a single file` };
}

/**
 * A bot that can hand something over in this conversation: the first agent in
 * it with a live channel. Attribution is not lost by this — an artifact that
 * HAS an author keeps it; this only answers "who can carry the file" for one
 * that never had an author to begin with.
 */
function delivererFor(conversationId: string): string | null {
  const conversation = getConversation(conversationId);
  if (!conversation) return null;
  for (const agentId of conversation.agentIds) {
    if (getFeishuChannelForAgent(agentId)) return agentId;
  }
  return null;
}

export type DeliveryOutcome =
  | { status: "delivered"; chatId: string; fileName: string }
  | { status: "skipped"; reason: string };

export async function projectArtifact(artifact: Artifact): Promise<DeliveryOutcome> {
  if (isChannelProjectionPaused()) return { status: "skipped", reason: "paused" };

  const channelConversation = getChannelConversationByConversationId(artifact.conversationId);
  if (!channelConversation) return { status: "skipped", reason: "conversation is not on a channel" };

  // An artifact may have no author: one made on the web page belongs to the
  // conversation, not to an agent. The room still has bots — the agents in this
  // conversation — so the file is handed over by the first of them that has a
  // live channel. Without this, every web-created artifact was skipped as
  // "no author" and the create path was dead code.
  const agentId = artifact.createdByAgentId ?? delivererFor(artifact.conversationId);
  if (!agentId) {
    return { status: "skipped", reason: "no agent in this conversation has a live channel" };
  }

  const channel = getFeishuChannelForAgent(agentId);
  if (!channel) return { status: "skipped", reason: "agent has no live channel" };

  // One delivery per artifact. Nothing else stopped a second: `deploy_artifact`
  // on a document re-announces it, and a message projection would send a file
  // for the same artifact again.
  const delivered = getDeliveredArtifacts();
  if (delivered.has(artifact.id)) return { status: "skipped", reason: "already delivered" };

  const workspace = getWorkspaceForConversation(artifact.conversationId);
  const file = artifactFileFor(artifact, workspace ?? null);
  if ("reason" in file) {
    // Said out loud: a skip nobody can see is indistinguishable from a bug.
    console.info(`[feishu] not delivering ${artifact.id}: ${file.reason}`);
    return { status: "skipped", reason: file.reason };
  }

  // The rate limit applies, and is RECORDED. It used to be checked and never
  // counted, so twenty-five artifacts went out inside one twenty-message
  // window — a limit that does not count is not a limit.
  const now = Date.now();
  if (!withinSendBudget(artifact.conversationId, now)) {
    console.info(`[feishu] not delivering ${artifact.id}: send budget exhausted`);
    return { status: "skipped", reason: "send budget exhausted" };
  }

  const sent = await deliverSend<{ messageId: string }>(
    channel,
    artifact.conversationId,
    agentId,
    channelConversation.chatId,
    { file: { source: file.content, fileName: file.name } }
  );
  recordSend(artifact.conversationId, now);
  delivered.add(artifact.id);
  console.info(
    `[feishu] delivered ${file.name} (${file.content.length} bytes) to ${channelConversation.chatId} (${sent.messageId})`
  );
  return { status: "delivered", chatId: channelConversation.chatId, fileName: file.name };
}

declare global {
  var __agentMeldChannelArtifactStop: (() => void) | undefined;
  var __agentMeldDeliveredArtifacts: Set<string> | undefined;
}

function getDeliveredArtifacts(): Set<string> {
  globalThis.__agentMeldDeliveredArtifacts ??= new Set<string>();
  return globalThis.__agentMeldDeliveredArtifacts;
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
  globalThis.__agentMeldDeliveredArtifacts = undefined;
}
