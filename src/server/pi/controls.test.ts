import { describe, expect, it, vi } from "vitest";
import { registerPiControl, submitPiFollowup, type PiFollowupReceipt } from "./controls";

describe("Pi follow-up admission and consumption receipts", () => {
  it("keeps an acknowledged command queued until Pi commits that exact user message", async () => {
    const receipts: PiFollowupReceipt[] = [];
    const request = vi.fn(async () => ({}));
    const control = registerPiControl({ runId: "controls-one", allowFollowup: true, signal: new AbortController().signal, request });
    try {
      const result = await submitPiFollowup("controls-one", { id: "f1", kind: "steer", text: "Discuss the second proposal" }, receipt => receipts.push(receipt));
      expect(result.state).toBe("queued");
      const packet = (request.mock.calls[0] as unknown as [string, { message: string }])[1].message;
      control.observe({ type: "message_start", message: { role: "user", content: [{ type: "text", text: packet }] } });
      expect(receipts.map(receipt => receipt.state)).toEqual(["queued"]);
      control.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: packet }] } });
      expect(receipts).toHaveLength(1);
      control.observe({ type: "message_end", message: { role: "user", content: [{ type: "text", text: packet }] } });
      expect(receipts.map(receipt => receipt.state)).toEqual(["queued", "applied"]);
    } finally { control.close(); }
  });

  it("does not steer a writer or a delegated execution contract", async () => {
    const request = vi.fn(async () => ({}));
    const control = registerPiControl({ runId: "controls-writer", allowFollowup: false, signal: new AbortController().signal, request });
    try {
      expect((await submitPiFollowup("controls-writer", { id: "f1", kind: "steer", text: "Change the color" }, () => {})).state).toBe("rejected");
      expect(request).not.toHaveBeenCalled();
    } finally { control.close(); }
  });

  it("does not turn arbitrary JSON command names into Pi RPC commands", async () => {
    const request = vi.fn(async () => ({}));
    const control = registerPiControl({ runId: "controls-kind", allowFollowup: true, signal: new AbortController().signal, request });
    try {
      expect((await submitPiFollowup("controls-kind", { id: "f1", kind: "new_session", text: "Reset" } as never, () => {})).state).toBe("rejected");
      expect(request).not.toHaveBeenCalled();
    } finally { control.close(); }
  });

  it("is idempotent, bounded and rejects conflicting identities", async () => {
    const request = vi.fn(async () => ({}));
    const control = registerPiControl({ runId: "controls-bounded", allowFollowup: true, signal: new AbortController().signal, request });
    try {
      const input = { id: "f1", kind: "follow_up" as const, text: "Explain" };
      await submitPiFollowup("controls-bounded", input, () => {});
      await submitPiFollowup("controls-bounded", input, () => {});
      expect(request).toHaveBeenCalledTimes(1);
      expect((await submitPiFollowup("controls-bounded", { ...input, text: "Different" }, () => {})).state).toBe("rejected");
      for (let i = 2; i <= 8; i++) await submitPiFollowup("controls-bounded", { ...input, id: `f${i}` }, () => {});
      expect((await submitPiFollowup("controls-bounded", { ...input, id: "f9" }, () => {})).state).toBe("rejected");
      expect(request).toHaveBeenCalledTimes(8);
    } finally { control.close(); }
  });

  it("settles unconsumed messages on cancellation and removes the native control handle", async () => {
    const abort = new AbortController();
    const receipts: PiFollowupReceipt[] = [];
    const control = registerPiControl({ runId: "controls-cancel", allowFollowup: true, signal: abort.signal, request: async () => ({}) });
    await submitPiFollowup("controls-cancel", { id: "f1", kind: "steer", text: "Explain" }, receipt => receipts.push(receipt));
    abort.abort();
    control.close();
    expect(receipts.at(-1)?.state).toBe("cancelled");
    expect((await submitPiFollowup("controls-cancel", { id: "f2", kind: "steer", text: "Late" }, () => {})).state).toBe("rejected");
  });

  it("refuses to send when the durable queue receipt could not be saved", async () => {
    const request = vi.fn(async () => ({}));
    const control = registerPiControl({ runId: "controls-storage", allowFollowup: true, signal: new AbortController().signal, request });
    try {
      await expect(submitPiFollowup("controls-storage", { id: "f1", kind: "steer", text: "Explain" }, () => { throw new Error("storage failed"); })).rejects.toThrow("storage failed");
      expect(request).not.toHaveBeenCalled();
    } finally { control.close(); }
  });
});
