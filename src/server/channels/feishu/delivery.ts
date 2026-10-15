import type { LarkChannel } from "@larksuite/channel";

/**
 * Whether the channel is actually delivering.
 *
 * Until now a failed send existed only as a `console.error`. That is the wrong
 * shape for the question an operator has — "has this bot stopped posting?" — and
 * it is unanswerable from the platform's side too: the scopes a one-click app is
 * granted cannot read group messages back, so there is no delivery receipt to
 * consult. The only record of whether something arrived is the one this process
 * keeps.
 *
 * Failures are recorded and then RETHROWN. Every caller already handles a
 * failure its own way — a projection logs and moves on, a card action returns a
 * toast — and swallowing here would take that decision away from the place that
 * knows what the message was for.
 */

export interface DeliveryHealth {
  conversationId: string;
  agentId: string;
  sent: number;
  failed: number;
  lastError: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

declare global {
  var __agentMeldChannelDelivery: Map<string, DeliveryHealth> | undefined;
}

function truncateToCodePoints(text: string, maxPoints: number): string {
  const points = [...text];
  return points.length > maxPoints ? points.slice(0, maxPoints).join("") : text;
}

function getRegistry(): Map<string, DeliveryHealth> {
  globalThis.__agentMeldChannelDelivery ??= new Map<string, DeliveryHealth>();
  return globalThis.__agentMeldChannelDelivery;
}

function touch(conversationId: string, agentId: string): DeliveryHealth {
  const key = `${conversationId}\u0000${agentId}`;
  const registry = getRegistry();
  let entry = registry.get(key);
  if (!entry) {
    entry = {
      conversationId,
      agentId,
      sent: 0,
      failed: 0,
      lastError: null,
      lastFailureAt: null,
      lastSuccessAt: null
    };
    registry.set(key, entry);
  }
  return entry;
}

async function attempt<T>(
  conversationId: string,
  agentId: string,
  work: () => Promise<T>
): Promise<T> {
  const entry = touch(conversationId, agentId);
  try {
    const result = await work();
    entry.sent += 1;
    entry.lastSuccessAt = Date.now();
    return result;
  } catch (error) {
    entry.failed += 1;
    entry.lastFailureAt = Date.now();
    // Truncated: an error string can carry a URL or a token, and this is
    // returned over an API.
    // Cut by code point, so the cut cannot leave half a surrogate pair — the
    // response would carry U+FFFD and the stored string would not match what
    // the error actually said. Bounded only to keep the payload small; this is
    // NOT a redaction, and a secret in the first 300 characters is still here.
    entry.lastError = truncateToCodePoints(
      error instanceof Error ? error.message : String(error),
      300
    );
    throw error;
  }
}

/** Send, and remember whether it worked. */
export function deliverSend<T>(
  channel: Pick<LarkChannel, "send"> & Partial<Pick<LarkChannel, "reply">>,
  conversationId: string,
  agentId: string,
  chatId: string,
  input: Parameters<LarkChannel["send"]>[1],
  /**
   * Where the question was asked. When the trigger came from inside a Feishu
   * topic, the answer goes back into that topic instead of starting a new one at
   * the top of the group; the SDK's `reply` is what keeps it there.
   *
   * Optional and capability-checked: a channel stub that only implements `send`
   * (and an app whose SDK predates `reply`) still posts, just not in-thread.
   */
  replyTo?: { chatId: string; messageId: string; threadId: string } | null
): Promise<T> {
  return attempt(conversationId, agentId, async () => {
    if (replyTo && typeof channel.reply === "function") {
      try {
        return (await channel.reply(replyTo, input)) as unknown as T;
      } catch (error) {
        // A withdrawn message, a closed topic, an app without reply permission:
        // failing here would lose the answer entirely, and this module calls
        // silence the worst of the available outcomes. Post it at the top level
        // instead — what would have happened without any of this.
        //
        // The cost, which the operations guide states as well: when the reply's
        // outcome is UNCERTAIN (a timeout, or an `unknown` that exhausted its
        // retries) the platform may have accepted it, and the room would then
        // see the answer twice — once in the topic and once at the top. The SDK
        // already handles the common `target_revoked` case internally by
        // resending without replyTo, so what reaches here is mostly a definite
        // failure (safe to fall back) or one of those uncertain ones. Choosing
        // "possibly twice" over "silently never" matches what the artifact
        // delivery path already does for the same reason.
        console.error("[feishu] reply failed; posting at the top level instead:", error);
      }
    }
    return channel.send(chatId, input) as unknown as Promise<T>;
  });
}

/** Update a card in place, and remember whether it worked. */
export function deliverCardUpdate(
  channel: Pick<LarkChannel, "updateCard">,
  conversationId: string,
  agentId: string,
  messageId: string,
  card: object
): Promise<void> {
  return attempt(conversationId, agentId, () => channel.updateCard(messageId, card));
}

/**
 * Every conversation this process has tried to post to, in insertion order.
 *
 * Deliberately not filtered to the failures: "nothing has ever failed" and
 * "nothing has ever been attempted" are different answers, and a list of only
 * failures cannot tell them apart.
 */
export function getDeliveryHealth(): DeliveryHealth[] {
  return [...getRegistry().values()].map((entry) => ({ ...entry }));
}

export function clearDeliveryHealthForTests(): void {
  globalThis.__agentMeldChannelDelivery = undefined;
}
