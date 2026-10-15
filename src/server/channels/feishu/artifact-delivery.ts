import fs from "node:fs";
import { eventBus } from "@/server/event-bus";
import {
  getChannelConversationByConversationId,
  getWorkspaceForConversation
} from "@/server/repositories";
import { getFeishuChannelForAgent } from "@/server/channels/feishu/registry";
import { listObservedAgents } from "@/server/channels/feishu/conversation-binding";
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

export type DeliveryOutcome =
  | { status: "delivered"; chatId: string; fileName: string }
  | { status: "skipped"; reason: string };

export async function projectArtifact(artifact: Artifact): Promise<DeliveryOutcome> {
  if (isChannelProjectionPaused()) return { status: "skipped", reason: "paused" };

  const channelConversation = getChannelConversationByConversationId(artifact.conversationId);
  if (!channelConversation) return { status: "skipped", reason: "conversation is not on a channel" };

  // An artifact may have no author: one made on the web page belongs to the
  // conversation, not to an agent. The room still has bots, but the candidate
  // list must come from the OBSERVED members of this group — `agentIds` is who
  // may speak in the conversation, not who is in the room, and
  // `getFeishuChannelForAgent` is documented as "this agent has a Feishu
  // presence", never as "use someone else's". A bot that is not in the group
  // fails to send, so each candidate is tried in turn instead of trusting the
  // first one that has a connection.
  const candidates = artifact.createdByAgentId
    ? [artifact.createdByAgentId]
    : listObservedAgents(channelConversation.id).filter((agentId) => getFeishuChannelForAgent(agentId));
  if (candidates.length === 0) {
    // The group IS on the channel but nobody in it can carry the file. Not the
    // ordinary "this conversation has no channel" silence — that one is most
    // conversations and must stay quiet — but an anomaly an operator needs to
    // see, and it happens before deliverSend so health records nothing either.
    console.info(
      `[feishu] not delivering ${artifact.id}: no agent observed in this group has a live channel`
    );
    return { status: "skipped", reason: "no agent observed in this group has a live channel" };
  }

  // One delivery per artifact. Nothing else stopped a second: `deploy_artifact`
  // on a document re-announces it, and a message projection would send a file
  // for the same artifact again.
  const delivered = getDeliveredArtifacts();
  if (delivered.has(artifact.id)) return { status: "skipped", reason: "already delivered" };

  // The message rate limit applies to this too: a file is a message.
  const now = Date.now();
  if (!withinSendBudget(artifact.conversationId, now)) {
    console.info(`[feishu] not delivering ${artifact.id}: send budget exhausted`);
    return { status: "skipped", reason: "send budget exhausted" };
  }

  const workspace = getWorkspaceForConversation(artifact.conversationId);
  const file = artifactFileFor(artifact, workspace ?? null);
  if ("reason" in file) {
    // A skip nobody can see is indistinguishable from a bug, and these skips
    // happen BEFORE deliverSend, so they leave no trace in delivery health
    // either. This line is what the operations guide tells an operator to grep.
    console.info(`[feishu] not delivering ${artifact.id}: ${file.reason}`);
    return { status: "skipped", reason: file.reason };
  }

  // The file is the same whoever carries it, so it is built once and offered to
  // each candidate until one succeeds.
  //
  // The cost of trying the next candidate: a send that the platform accepted
  // but reported as failed (a timeout, a lost response) is retried by the next
  // bot, and the room can receive the file twice. At-most-once would drop the
  // file whenever the FIRST candidate happens to be a bot that is not in the
  // group, which is the case this loop exists for; the trade is documented in
  // the operations guide rather than left implicit.
  let lastReason = "no agent observed in this group has a live channel";
  for (const agentId of candidates) {
    const channel = getFeishuChannelForAgent(agentId);
    if (!channel) {
      lastReason = "agent has no live channel";
      continue;
    }
    try {
      const sent = await deliverSend<{ messageId: string }>(
        channel,
        artifact.conversationId,
        agentId,
        channelConversation.chatId,
        { file: { source: file.content, fileName: file.name } }
      );
      recordSend(artifact.conversationId, Date.now());
      delivered.add(artifact.id);
      console.info(
        `[feishu] delivered ${file.name} (${file.content.length} bytes) to ${channelConversation.chatId} (${sent.messageId})`
      );
      return { status: "delivered", chatId: channelConversation.chatId, fileName: file.name };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : "the send failed";
      console.error(`[feishu] failed to deliver ${artifact.id} as ${agentId}:`, error);
    }
  }
  console.info(`[feishu] not delivering ${artifact.id}: ${lastReason}`);
  return { status: "skipped", reason: lastReason };
}

declare global {
  var __agentMeldChannelArtifactStop: (() => void) | undefined;
  var __agentMeldDeliveredArtifacts: Set<string> | undefined;
}

/**
 * Which artifacts the room has already been given.
 *
 * Kept in memory: a restart re-delivering what is already in the room would be
 * worse than the rare miss, and the platform's own message history is not
 * readable with a one-click app's scopes.
 */
function getDeliveredArtifacts(): Set<string> {
  globalThis.__agentMeldDeliveredArtifacts ??= new Set<string>();
  return globalThis.__agentMeldDeliveredArtifacts;
}

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
