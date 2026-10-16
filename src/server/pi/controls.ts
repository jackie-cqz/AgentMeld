import { randomUUID } from "node:crypto";
import type { PiRecord } from "./protocol";
import { PiRuntimeError } from "./process";

export interface PiFollowup {
  id: string;
  kind: "steer" | "follow_up";
  text: string;
}
export interface PiFollowupReceipt {
  id: string;
  runId: string;
  state: "queued" | "applied" | "rejected" | "cancelled";
  reason: string | null;
}
type ReceiptListener = (receipt: PiFollowupReceipt) => void;
interface PendingFollowup {
  input: PiFollowup;
  packet: string;
  receipt: PiFollowupReceipt;
  listener: ReceiptListener;
}

const controls = new Map<string, ReturnType<typeof createControl>>();

function createControl(options: {
  runId: string;
  allowFollowup: boolean;
  signal: AbortSignal;
  request: (kind: string, params: Record<string, unknown>) => Promise<unknown>;
}) {
  let open = true;
  const nonce = randomUUID();
  const pending = new Map<string, PendingFollowup>();
  const transition = (item: PendingFollowup, state: PiFollowupReceipt["state"], reason: string | null = null) => {
    if (item.receipt.state !== "queued") return;
    item.receipt = { ...item.receipt, state, reason };
    item.listener(item.receipt);
  };
  return {
    async submit(input: PiFollowup, listener: ReceiptListener): Promise<PiFollowupReceipt> {
      const reject = (reason: string): PiFollowupReceipt => {
        const receipt: PiFollowupReceipt = { id: input.id, runId: options.runId, state: options.signal.aborted ? "cancelled" : "rejected", reason };
        listener(receipt);
        return receipt;
      };
      if (!open || options.signal.aborted) return reject("The invocation is no longer accepting follow-ups.");
      if (!options.allowFollowup) return reject("This execution contract requires a fresh authorized attempt instead of live steering.");
      if (typeof input.id !== "string" || !input.id || input.id.length > 100 || typeof input.text !== "string" ||
        !input.text.trim() || input.text.length > 24_000 || !["steer", "follow_up"].includes(input.kind)) return reject("Invalid or oversized follow-up.");
      const previous = pending.get(input.id);
      if (previous) {
        if (previous.input.kind !== input.kind || previous.input.text !== input.text) return reject("Follow-up identity already names different content.");
        listener(previous.receipt);
        return previous.receipt;
      }
      if (pending.size >= 8) return reject("The invocation follow-up budget is exhausted.");
      const packet = `<platform_followup id="${nonce}">\n${JSON.stringify({ id: input.id, text: input.text })}\n</platform_followup>`;
      const item: PendingFollowup = { input: { ...input }, packet, listener,
        receipt: { id: input.id, runId: options.runId, state: "queued", reason: null } };
      // Persist the queue receipt before transport can produce a consumed event.
      listener(item.receipt);
      pending.set(input.id, item);
      try { await options.request(input.kind, { message: packet }); }
      catch { transition(item, options.signal.aborted ? "cancelled" : "rejected", "Pi did not acknowledge the follow-up command."); }
      // An RPC ack never promotes queued to applied; only observe() can do so.
      return item.receipt;
    },
    observe(record: PiRecord) {
      if (record.type !== "message_end" || !record.message || typeof record.message !== "object") return;
      const message = record.message as { role?: unknown; content?: unknown };
      if (message.role !== "user" || !Array.isArray(message.content)) return;
      const text = message.content.map(part => part && typeof part === "object" && part.type === "text" && typeof part.text === "string" ? part.text : "").join("");
      for (const item of pending.values()) if (item.packet === text) transition(item, "applied");
    },
    close() {
      open = false;
      let failure: unknown;
      for (const item of pending.values()) {
        try { transition(item, options.signal.aborted ? "cancelled" : "rejected", "The invocation ended before consuming this follow-up."); }
        catch (error) { failure ??= error; }
      }
      if (failure) throw failure;
    },
  };
}

/** One currently active native invocation per platform run; no public RPC endpoint. */
export function registerPiControl(options: Parameters<typeof createControl>[0]) {
  if (controls.has(options.runId)) throw new PiRuntimeError("Another Pi invocation already owns this run's control channel.", "protocol");
  const control = createControl(options);
  controls.set(options.runId, control);
  return {
    observe: control.observe,
    close: () => {
      try { control.close(); }
      finally { if (controls.get(options.runId) === control) controls.delete(options.runId); }
    },
  };
}

export async function submitPiFollowup(runId: string, input: PiFollowup, listener: ReceiptListener): Promise<PiFollowupReceipt> {
  const control = controls.get(runId);
  if (control) return control.submit(input, listener);
  const receipt: PiFollowupReceipt = { id: input.id, runId, state: "rejected", reason: "No active Pi invocation is accepting follow-ups for this run." };
  listener(receipt);
  return receipt;
}
