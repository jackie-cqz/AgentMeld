import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLarkChannel } from "@larksuite/channel";
import { setupTestDatabase } from "@/test/test-database";
import { buildProgressCard } from "@/server/channels/feishu/progress";
import { handleCardAction } from "@/server/channels/feishu/interaction";
import {
  createChannelConversation,
  createConversation,
  createRun,
  upsertChannelBinding
} from "@/server/repositories";
import type { AgentRun } from "@/shared/types";

/**
 * The layer every other card test skips: the SDK itself.
 *
 * Each of these cards is handed to the handler as a hand-built value, which is
 * precisely how two buttons shipped dead without anything noticing — the decoder
 * rejected one outright, and the SDK silently drops the other on its second
 * press. This file drives the SDK's own dispatch for `card.action.trigger`, so
 * the path exercised is the real one: normalise → dedup → queue → our handler.
 *
 * It runs entirely offline. `createLarkChannel` only builds an object; nothing
 * touches the network until an API call or `connect()`, and neither happens
 * here. Reaching into `registerDispatcherHandlers` and `builtinHandlers` — both
 * private — is deliberate: if the SDK moves them, this fails loudly instead of
 * quietly testing nothing.
 */

/** Every value a card's buttons carry. */
function buttonValues(card: object): unknown[] {
  const elements = (card as {
    elements: Array<{ tag: string; actions?: Array<{ value?: unknown }> }>;
  }).elements;
  return elements
    .filter((element) => element.tag === "action")
    .flatMap((element) => element.actions ?? [])
    .map((button) => button.value);
}

describe("a click reaching us through the SDK", () => {
  let teardown: () => void;
  let channel: ReturnType<typeof createLarkChannel>;
  let dispatch: (messageId: string, openId: string, value: unknown) => Promise<unknown>;
  let handled: number;
  let run: AgentRun;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-sdk-dedup-");
    handled = 0;

    channel = createLarkChannel({ appId: "cli_probe", appSecret: "probe", source: "dedup-test" });
    channel.on("cardAction", async (event) => {
      handled += 1;
      return handleCardAction(event, "cli_pm");
    });
    const inner = channel as unknown as {
      registerDispatcherHandlers?: () => void;
      builtinHandlers?: Record<string, (raw: unknown) => Promise<unknown>>;
    };
    inner.registerDispatcherHandlers?.();
    const handler = inner.builtinHandlers?.["card.action.trigger"];
    if (typeof handler !== "function") {
      throw new Error("the SDK no longer exposes its card.action.trigger handler; this test needs rewriting");
    }
    dispatch = (messageId: string, openId: string, value: unknown) =>
      handler({
        open_message_id: messageId,
        open_chat_id: "oc_1",
        operator: { open_id: openId },
        action: { tag: "button", value }
      });

    createConversation({
      id: "conv_1", title: "飞书群", mode: "group", agentIds: ["ag_pm"],
      fsWriteApprovalMode: "auto", now: 1
    });
    createChannelConversation({
      id: "cc_1", channel: "feishu", chatId: "oc_1", conversationId: "conv_1", now: 1
    });
    upsertChannelBinding({
      id: "cb_pm", agentId: "ag_pm", channel: "feishu", appId: "cli_pm", appSecret: "s",
      boundByOpenId: "ou_owner", now: 1
    });
    run = createRun({
      id: "run_probe", conversationId: "conv_1", agentId: "ag_pm",
      triggerMessageId: null, parentRunId: null, status: "running", now: Date.now()
    });
  });

  afterEach(() => {
    teardown();
  });

  it("reaches the handler once, and is silently dropped when repeated unchanged", async () => {
    // What the room actually does to this feature, pinned. The SDK remembers a
    // click — same person, same message, same value — for twelve hours, in a
    // cache that survives a restart, and drops every later one before our code
    // runs. A status button whose value never changed could be pressed once per
    // person per card, which is why each rewrite carries a new version.
    const [statusValue] = buttonValues(buildProgressCard(run, "PM 小灰"));

    const first = await dispatch("om_probe_1", "ou_owner", statusValue);
    expect(handled).toBe(1);
    expect(first).toMatchObject({ toast: { type: "info" } });

    const second = await dispatch("om_probe_1", "ou_owner", statusValue);
    expect(handled).toBe(1);
    // No response at all: not our refusal, the SDK never asked us.
    expect(second).toBeUndefined();
  });

  it("works again once the card has been rewritten with a new version", async () => {
    const stale = buttonValues(buildProgressCard(run, "PM 小灰"))[0];
    const fresh = buttonValues(buildProgressCard(run, "PM 小灰", undefined, undefined, 1)).find(
      (value) => (value as { kind: string }).kind === "run_status"
    );

    await dispatch("om_probe_2", "ou_owner", stale);
    expect(handled).toBe(1);

    // The card on screen now carries version 1; pressing it is a different
    // action as far as the SDK is concerned.
    const again = await dispatch("om_probe_2", "ou_owner", fresh);
    expect(handled).toBe(2);
    expect(again).toMatchObject({ toast: { type: "info" } });
  });

  it("treats two people as two actors, and answers both", async () => {
    // Status is read-only, so it is not the owner's alone; the SDK's dedup is
    // per person, and so is ours.
    const value = buttonValues(buildProgressCard(run, "PM 小灰"))[0];

    const owner = await dispatch("om_probe_3", "ou_owner", value);
    const other = await dispatch("om_probe_3", "ou_member", value);

    expect(handled).toBe(2);
    expect(owner).toMatchObject({ toast: { type: "info" } });
    expect(other).toMatchObject({ toast: { type: "info" } });
  });
});
