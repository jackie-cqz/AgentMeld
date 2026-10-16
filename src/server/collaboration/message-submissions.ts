import { getDatabase } from "@/db/client";
import { getMessage } from "@/server/repositories";
import type { Message } from "@/shared/types";

export class MessageSubmissionError extends Error {
  constructor(message: string, readonly code: "SUBMISSION_CONFLICT" | "SUBMISSION_INTERRUPTED" | "SUBMISSION_PROCESSING") { super(message); }
}
export interface SubmissionOutcome { runIds: string[]; deploy?: unknown }

/** Atomic receipt + message creation. Replays never start another run or deployment. */
export function claimMessageSubmission(conversationId: string, requestKey: string, payloadHash: string, create: () => Message):
  { message: Message; replay: true; outcome: SubmissionOutcome } | { message: Message; replay: false } {
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT * FROM message_submissions WHERE conversation_id=? AND request_key=?").get(conversationId, requestKey) as
      { payload_hash: string; message_id: string; status: string; response_json: string | null } | undefined;
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new MessageSubmissionError("同一发送标识不能用于不同内容。", "SUBMISSION_CONFLICT");
      if (existing.status === "received") throw new MessageSubmissionError("这条消息仍在处理，请稍后重试查询同一次发送。", "SUBMISSION_PROCESSING");
      if (existing.status !== "dispatched" || !existing.response_json) throw new MessageSubmissionError("上一次发送已中断。请确认现有工作状态后重新发送。", "SUBMISSION_INTERRUPTED");
      const message = getMessage(existing.message_id);
      if (!message) throw new MessageSubmissionError("上次发送的消息已不存在。", "SUBMISSION_INTERRUPTED");
      const outcome = JSON.parse(existing.response_json) as SubmissionOutcome;
      db.exec("COMMIT");
      return { message, replay: true, outcome };
    }
    const message = create();
    const now = Date.now();
    db.prepare("INSERT INTO message_submissions (conversation_id,request_key,payload_hash,message_id,status,created_at,updated_at) VALUES (?,?,?,?,'received',?,?)")
      .run(conversationId, requestKey, payloadHash, message.id, now, now);
    db.exec("COMMIT");
    return { message, replay: false };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function finishMessageSubmission(conversationId: string, requestKey: string, outcome: SubmissionOutcome | null): void {
  getDatabase().prepare("UPDATE message_submissions SET status=?,response_json=?,updated_at=? WHERE conversation_id=? AND request_key=? AND status='received'")
    .run(outcome ? "dispatched" : "interrupted", outcome ? JSON.stringify(outcome) : null, Date.now(), conversationId, requestKey);
}
