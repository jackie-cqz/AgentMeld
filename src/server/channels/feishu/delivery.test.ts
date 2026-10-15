import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDeliveryHealthForTests,
  deliverCardUpdate,
  deliverSend,
  getDeliveryHealth
} from "@/server/channels/feishu/delivery";

/**
 * Delivery health exists because the question "has this bot stopped posting?"
 * had no answer anywhere: a failed send was a `console.error`, and the platform
 * cannot be asked — the scopes a one-click app is granted cannot read group
 * messages back.
 */
describe("a reply target on a channel that cannot reply", () => {
  it("still posts through send", async () => {
    // The capability check: a channel stub (or an SDK without `reply`) must not
    // turn a reply target into a TypeError that loses the message.
    const sends: Array<{ chatId: string; input: unknown }> = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const channel = {
      send: async (chatId: string, input: unknown) => {
        sends.push({ chatId, input });
        return { messageId: "om_out" };
      }
    };
    try {
      const result = await deliverSend<{ messageId: string }>(
        channel,
        "conv_1",
        "ag_pm",
        "oc_1",
        { text: "回答" },
        { chatId: "oc_1", messageId: "om_question", threadId: "omt_1" }
      );

      expect(result.messageId).toBe("om_out");
      expect(sends).toHaveLength(1);
      expect(sends[0].chatId).toBe("oc_1");
      // And it did not go through the failure path: a channel that cannot reply
      // is not a reply that failed, and the log has to say which happened.
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("falls back to send when the reply itself fails", async () => {
    // A withdrawn question, a closed topic, an app without reply permission:
    // losing the answer entirely is the worst outcome, so the top level is used.
    const sends: unknown[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const channel = {
      send: async () => {
        sends.push("sent");
        return { messageId: "om_fallback" };
      },
      reply: async () => {
        throw new Error("message withdrawn");
      }
    };
    try {
      const result = await deliverSend<{ messageId: string }>(
        channel,
        "conv_1",
        "ag_pm",
        "oc_1",
        { text: "回答" },
        { chatId: "oc_1", messageId: "om_question", threadId: "omt_1" }
      );
      expect(result.messageId).toBe("om_fallback");
      expect(sends).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("delivery health", () => {
  beforeEach(() => {
    clearDeliveryHealthForTests();
  });

  afterEach(() => {
    clearDeliveryHealthForTests();
  });

  const channelWith = (behaviour: () => Promise<unknown>) => ({
    send: behaviour,
    updateCard: behaviour
  });

  it("counts a send that worked", async () => {
    const channel = channelWith(async () => ({ messageId: "om_1" }));

    await deliverSend(channel as never, "conv_1", "ag_pm", "oc_1", { text: "hi" });

    const [entry] = getDeliveryHealth();
    expect(entry).toMatchObject({ conversationId: "conv_1", agentId: "ag_pm", sent: 1, failed: 0 });
    expect(entry.lastSuccessAt).not.toBeNull();
  });

  it("counts a failure and keeps the message", async () => {
    const channel = channelWith(async () => {
      throw new Error("chat not found");
    });

    await expect(
      deliverSend(channel as never, "conv_1", "ag_pm", "oc_1", { text: "hi" })
    ).rejects.toThrow("chat not found");

    const [entry] = getDeliveryHealth();
    expect(entry).toMatchObject({ sent: 0, failed: 1, lastError: "chat not found" });
    expect(entry.lastFailureAt).not.toBeNull();
  });

  it("rethrows, so the caller keeps its own decision about a failure", async () => {
    // A projection logs and moves on; a card action returns a toast. Swallowing
    // here would take that decision from the place that knows what the message
    // was for.
    const channel = channelWith(async () => {
      throw new Error("boom");
    });

    await expect(deliverCardUpdate(channel as never, "conv_1", "ag_pm", "om_1", {})).rejects.toThrow(
      "boom"
    );
    expect(getDeliveryHealth()[0].failed).toBe(1);
  });

  it("lists a conversation that has never failed", async () => {
    // "Nothing has ever failed" and "nothing has ever been tried" are different
    // answers, and a list of failures cannot tell them apart.
    const channel = channelWith(async () => ({ messageId: "om_1" }));
    await deliverSend(channel as never, "conv_1", "ag_pm", "oc_1", { text: "hi" });

    expect(getDeliveryHealth()).toHaveLength(1);
    expect(getDeliveryHealth()[0].lastError).toBeNull();
  });

  it("keeps one row per conversation AND agent", async () => {
    // Two agents in ONE conversation, which is what the key is for. The first
    // version of this test used one agent throughout, so dropping the agent
    // from the key left it passing.
    const ok = channelWith(async () => ({ messageId: "om_1" }));
    await deliverSend(ok as never, "conv_1", "ag_pm", "oc_1", { text: "a" });
    await deliverSend(ok as never, "conv_1", "ag_pm", "oc_1", { text: "b" });
    await deliverSend(ok as never, "conv_1", "ag_dev", "oc_1", { text: "c" });

    const rows = getDeliveryHealth();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.agentId === "ag_pm")?.sent).toBe(2);
    expect(rows.find((r) => r.agentId === "ag_dev")?.sent).toBe(1);
  });

  it("truncates an error, because this is returned over an API", async () => {
    const channel = channelWith(async () => {
      throw new Error("x".repeat(900));
    });
    await expect(deliverSend(channel as never, "conv_1", "ag_pm", "oc_1", { text: "hi" })).rejects.toThrow();

    expect(getDeliveryHealth()[0].lastError).toHaveLength(300);
  });

  it("counts a non-Error throw without losing it", async () => {
    const channel = channelWith(async () => {
      throw "a string, not an Error";
    });
    await expect(deliverSend(channel as never, "conv_1", "ag_pm", "oc_1", { text: "hi" })).rejects.toBe(
      "a string, not an Error"
    );

    expect(getDeliveryHealth()[0].lastError).toBe("a string, not an Error");
  });

  it("starts empty", () => {
    expect(getDeliveryHealth()).toEqual([]);
  });
});
