import type { ChannelBindingSession, StreamEvent } from "@/shared/types";
import type { StoreDraft } from "@/stores/store-helpers";

const TERMINAL: ChannelBindingSession["status"][] = ["succeeded", "failed", "cancelled"];

/**
 * Fold one session from a list response into what we already know.
 *
 * Two things a snapshot must not do:
 *
 * - Undo a terminal status we learned from the stream. The event and the list
 *   are two sources racing each other, and a snapshot taken before the attempt
 *   finished would otherwise send a succeeded row back to "waiting to scan"
 *   with no way to recover.
 * - Drop a launcher URL we already hold. After a reload this response is the
 *   client's only source of that URL, and a response without it makes the QR
 *   code vanish from the dialog.
 */
export function mergeSession(
  previous: ChannelBindingSession | undefined,
  incoming: ChannelBindingSession
): ChannelBindingSession {
  if (!previous) return incoming;

  const status =
    TERMINAL.includes(previous.status) && !TERMINAL.includes(incoming.status)
      ? previous.status
      : incoming.status;

  const merged: ChannelBindingSession = {
    ...previous,
    ...incoming,
    status,
    // 0 means "not reported"; keep what we know rather than forgetting it.
    expiresAt: incoming.expiresAt > 0 ? incoming.expiresAt : previous.expiresAt
  };

  const qrUrl = incoming.qrUrl ?? previous.qrUrl;
  if (qrUrl) merged.qrUrl = qrUrl;
  else delete merged.qrUrl;

  return merged;
}

export function mergeSessions(
  existing: Record<string, ChannelBindingSession>,
  incoming: ChannelBindingSession[]
): Record<string, ChannelBindingSession> {
  return Object.fromEntries(
    incoming.map((session) => [session.id, mergeSession(existing[session.id], session)])
  );
}

/**
 * Channel-binding events are not conversation-scoped, so this reducer never
 * touches conversation buckets — only the session it names.
 *
 * The event carries no launcher URL, so a session reaching a terminal state
 * must drop any URL this client learned from the start response. Otherwise a
 * finished attempt would keep offering a spent QR code.
 */
export function applyChannelEvent(state: StoreDraft, event: StreamEvent): boolean {
  if (event.type !== "channel.binding.updated") return false;

  const existing = state.channelBindingSessions[event.sessionId];
  const next = {
    id: event.sessionId,
    agentId: event.agentId,
    status: event.status,
    // Unknown for a session this client learned about from the stream rather
    // than from the start response. 0 means unknown here, NOT expired; the
    // panel must not render a countdown from it.
    expiresAt: existing?.expiresAt ?? 0
  };

  // The app id and the row id come with a success, and the panel needs them:
  // without them the row would fall back to "unbound" until a refetch lands,
  // which reads as the binding having failed.
  if (event.appId) Object.assign(next, { appId: event.appId });
  if (event.bindingId) Object.assign(next, { bindingId: event.bindingId });

  state.channelBindingSessions[event.sessionId] = event.status === "awaiting_scan" && existing?.qrUrl
    ? { ...next, qrUrl: existing.qrUrl }
    : event.error
      ? { ...next, error: event.error }
      : next;

  return true;
}
