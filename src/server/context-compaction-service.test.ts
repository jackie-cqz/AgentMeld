import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { createConversation } from "@/server/conversation-service";
import { createMessage } from "@/server/repositories";
import { newContextSummaryId, newMessageId } from "@/shared/ids";
import { getDatabase } from "@/db/client";
import {
  selectCompactionWindow,
  serializeMessageForCompaction,
  chunkCompactionMessages,
  validateSummaryBoundary,
  calculateContextBudget,
  getLatestSummary,
  getArtifactTitleMap
} from "@/server/context-compaction-service";
import type { Message } from "@/shared/types";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-ctx-comp-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  eventBus.clearForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeMessage(overrides: Partial<Message> = {}): Message {
  const now = Date.now();
  return createMessage({
    id: overrides.id ?? newMessageId(),
    conversationId: overrides.conversationId ?? "conv_test",
    role: overrides.role ?? "user",
    parts: overrides.parts ?? [{ type: "text", content: "Hello" }],
    status: overrides.status ?? "complete",
    now: overrides.createdAt ?? now
  });
}

// ---------------------------------------------------------------------------
// P0: selectCompactionWindow
// ---------------------------------------------------------------------------

describe("selectCompactionWindow", () => {
  it("blocks when not enough messages", () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    // Only 3 messages total, need 8 + 3 = 11
    for (let i = 0; i < 3; i++) {
      createMessage({ id: `m${i}`, conversationId: conv.id, role: "user", parts: [{ type: "text", content: `msg${i}` }], status: "complete", now: Date.now() + i });
    }
    const w = selectCompactionWindow(conv.id);
    expect(w.blockingReason).toBeTruthy();
    expect(w.sourceMessages).toHaveLength(0);
  });

  it("selects messages beyond last 8 (keepRecent)", () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const msgs: Message[] = [];
    for (let i = 0; i < 15; i++) {
      const m = createMessage({ id: `m${i}`, conversationId: conv.id, role: "user", parts: [{ type: "text", content: `msg${i}` }], status: "complete", now: Date.now() + i });
      msgs.push(m);
    }
    const w = selectCompactionWindow(conv.id);
    expect(w.blockingReason).toBeNull();
    expect(w.sourceMessages.length).toBe(7); // 15 - 8 = 7 compactable
    expect(w.keptRecent.length).toBe(8);
    expect(w.coveredUntilMessageId).toBe(msgs[6].id); // last source
  });

  it("respects summary boundary (messageId-based)", () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) {
      const m = createMessage({ id: `m${i}`, conversationId: conv.id, role: "user", parts: [{ type: "text", content: `msg${i}` }], status: "complete", now: Date.now() + i });
      msgs.push(m);
    }
    // Store a summary covering first 5 messages
    const db = getDatabase();
    db.prepare(`INSERT INTO conversation_context_summaries (id, conversation_id, summary, covered_until_message_id, covered_until_created_at, source_message_count, token_estimate, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(newContextSummaryId(), conv.id, "old summary", msgs[4].id, msgs[4].createdAt, 5, 100, Date.now());

    const w = selectCompactionWindow(conv.id);
    expect(w.blockingReason).toBeNull();
    // After boundary m4, up to m19 — keep last 8 → source = m5..m11
    expect(w.sourceMessages[0].id).toBe("m5");
    expect(w.keptRecent.length).toBe(8);
  });

  it("errors when boundary message is missing", () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    for (let i = 0; i < 15; i++) {
      createMessage({ id: `m${i}`, conversationId: conv.id, role: "user", parts: [{ type: "text", content: `msg${i}` }], status: "complete", now: Date.now() + i });
    }
    const db = getDatabase();
    db.prepare(`INSERT INTO conversation_context_summaries (id, conversation_id, summary, covered_until_message_id, covered_until_created_at, source_message_count, token_estimate, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(newContextSummaryId(), conv.id, "orphan summary", "m_nonexistent", Date.now(), 5, 100, Date.now());

    const w = selectCompactionWindow(conv.id);
    expect(w.blockingReason).toContain("summary_boundary_missing");
  });
});

// ---------------------------------------------------------------------------
// P2: chunkCompactionMessages
// ---------------------------------------------------------------------------

describe("chunkCompactionMessages", () => {
  let convId: string;

  beforeEach(() => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    convId = conv.id;
  });

  it("returns single chunk for small set", () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 5; i++) {
      msgs.push(makeMessage({ id: `m${i}`, conversationId: convId, role: "user", parts: [{ type: "text", content: `Short message ${i}` }] }));
    }
    const { chunks } = chunkCompactionMessages(msgs, new Map());
    expect(chunks.length).toBe(1);
    expect(chunks[0].messages.length).toBe(5);
  });

  it("splits oversized messages by paragraph with actual content", () => {
    const longPara = "A".repeat(5000);
    const hugeContent = [longPara, longPara, longPara, longPara, longPara, longPara, longPara, longPara, longPara, longPara].join("\n\n");
    const msgs = [makeMessage({ id: "big1", conversationId: convId, role: "agent", agentId: "ag_mock_builder", parts: [{ type: "text", content: hugeContent }] })];

    const { chunks } = chunkCompactionMessages(msgs, new Map());
    expect(chunks.length).toBeGreaterThan(1);
    const firstFragment = chunks[0].messages[0];
    expect(firstFragment.parts[0].type).toBe("text");
    expect((firstFragment.parts[0] as { content: string }).content.length).toBeLessThan(hugeContent.length);
  });

  it("preserves start/end message ids", () => {
    const msgs: Message[] = [];
    const longContent = "X".repeat(4000);
    for (let i = 0; i < 20; i++) {
      msgs.push(makeMessage({ id: `m${i}`, conversationId: convId, role: "user", parts: [{ type: "text", content: longContent }] }));
    }
    const { chunks } = chunkCompactionMessages(msgs, new Map());
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startMessageId).toBe("m0");
    expect(chunks[chunks.length - 1].endMessageId).toBe("m19");
  });
});

// ---------------------------------------------------------------------------
// P0: validateSummaryBoundary
// ---------------------------------------------------------------------------

describe("validateSummaryBoundary", () => {
  it("allows first summary (no existing)", () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    createMessage({ id: "m0", conversationId: conv.id, role: "user", parts: [{ type: "text", content: "hi" }], status: "complete", now: Date.now() });
    expect(validateSummaryBoundary(conv.id, "m0")).toBeNull();
  });

  it("blocks backward boundary", () => {
    const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const m0 = createMessage({ id: "m0", conversationId: conv.id, role: "user", parts: [{ type: "text", content: "hi" }], status: "complete", now: Date.now() });
    createMessage({ id: "m1", conversationId: conv.id, role: "user", parts: [{ type: "text", content: "hi2" }], status: "complete", now: Date.now() + 1 });

    const db = getDatabase();
    db.prepare(`INSERT INTO conversation_context_summaries (id, conversation_id, summary, covered_until_message_id, covered_until_created_at, source_message_count, token_estimate, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(newContextSummaryId(), conv.id, "summary1", m0.id, m0.createdAt, 1, 50, Date.now());

    // Try to cover m0 again — should fail (backwards)
    expect(validateSummaryBoundary(conv.id, "m0")).toContain("must be after");
  });
});

// ---------------------------------------------------------------------------
// P1: calculateContextBudget
// ---------------------------------------------------------------------------

describe("calculateContextBudget", () => {
  it("calculates remaining tokens correctly", () => {
    const b = calculateContextBudget(64000, 4096, 2000, 500, 1000, 200);
    expect(b.remainingTokens).toBe(64000 - 4096 - 2000 - 500 - 1000 - 200 - 128);
    expect(b.recentTokens).toBe(b.remainingTokens);
  });

  it("floors remainingTokens at 0", () => {
    const b = calculateContextBudget(8000, 4096, 4000, 0, 0, 1000);
    expect(b.remainingTokens).toBe(0);
  });
});
