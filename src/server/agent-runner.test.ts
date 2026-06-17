import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import {
  abortRun,
  isRunActive,
  startAgentRun
} from "@/server/agent-runner";
import {
  createConversation,
  sendMessage
} from "@/server/conversation-service";
import {
  getRun,
  listMessages
} from "@/server/repositories";
import type { StreamEvent } from "@/shared/types";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conference-run-"));
  process.env.AGENT_CONFERENCE_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetDatabaseForTests();
  eventBus.clearForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetDatabaseForTests();
  delete process.env.AGENT_CONFERENCE_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Collect all events that occur within `timeoutMs` — subscription starts
 * immediately, so we must call this BEFORE the action that triggers events.
 */
function startCollecting(timeoutMs = 8000): { events: StreamEvent[]; stop: () => StreamEvent[] } {
  const events: StreamEvent[] = [];
  const unsub = eventBus.subscribe((entry) => {
    events.push(entry.event);
  });

  let timer: ReturnType<typeof setTimeout>;
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });

  return {
    events,
    stop: () => {
      clearTimeout(timer!);
      unsub();
      return events;
    }
  };
}

/** Wait for a specific event type with subscription started BEFORE the action. */
function createEventWaiter(timeoutMs = 8000) {
  const events: StreamEvent[] = [];
  return {
    events,
    subscribe: () => {
      return eventBus.subscribe((entry) => {
        events.push(entry.event);
      });
    },
    waitFor: (eventType: StreamEvent["type"]): Promise<StreamEvent> => {
      return new Promise((resolve, reject) => {
        // Check if we already received it
        const existing = events.find((e) => e.type === eventType);
        if (existing) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(() => {
          unsub();
          reject(new Error(`Timed out waiting for "${eventType}". Received: ${events.map((e) => e.type).join(", ")}`));
        }, timeoutMs);
        const unsub = eventBus.subscribe((entry) => {
          events.push(entry.event);
          if (entry.event.type === eventType) {
            clearTimeout(timer);
            unsub();
            resolve(entry.event);
          }
        });
      });
    }
  };
}

describe("agent-runner", () => {
  it("completes a full mock agent run with all lifecycle events", async () => {
    const waiter = createEventWaiter();
    // Subscribe BEFORE sending the message
    const unsub = waiter.subscribe();

    const conv = createConversation({
      mode: "single",
      agentIds: ["ag_mock_builder"]
    });

    const result = await sendMessage({
      conversationId: conv.id,
      content: "test message"
    });

    expect(result.runIds).toHaveLength(1);
    const runId = result.runIds[0];

    const endEvent = await waiter.waitFor("run.end");
    unsub();
    expect(endEvent.type).toBe("run.end");
    if (endEvent.type === "run.end") {
      expect(endEvent.runId).toBe(runId);
      expect(endEvent.status).toBe("complete");
    }

    const run = getRun(runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe("complete");
    expect(run!.usage).not.toBeNull();

    const messages = listMessages(conv.id);
    const agentMessage = messages.find((m) => m.role === "agent");
    expect(agentMessage).toBeDefined();
    expect(agentMessage!.status).toBe("complete");
    expect(agentMessage!.parts.length).toBeGreaterThan(0);
  });

  it("produces an agent response message", async () => {
    const waiter = createEventWaiter();
    const unsub = waiter.subscribe();

    const conv = createConversation({
      mode: "single",
      agentIds: ["ag_mock_builder"]
    });

    await sendMessage({
      conversationId: conv.id,
      content: "hello"
    });

    await waiter.waitFor("run.end");
    unsub();

    const messages = listMessages(conv.id);
    const agentMessage = messages.find((m) => m.role === "agent");
    expect(agentMessage).toBeDefined();
    expect(agentMessage!.status).toBe("complete");
    expect(agentMessage!.parts.length).toBeGreaterThan(0);
  });

  it("completes a run for the agent", async () => {
    const waiter = createEventWaiter();
    const unsub = waiter.subscribe();

    const conv = createConversation({
      mode: "single",
      agentIds: ["ag_mock_builder"]
    });

    await sendMessage({
      conversationId: conv.id,
      content: "hello"
    });

    const endEvent = await waiter.waitFor("run.end");
    expect(endEvent.type).toBe("run.end");

    unsub();
    const messages = listMessages(conv.id);
    const agentMessage = messages.find((m) => m.role === "agent");
    expect(agentMessage).toBeDefined();
  });

  it("publishes run.start with correct fields", async () => {
    const waiter = createEventWaiter();
    const unsub = waiter.subscribe();

    const conv = createConversation({
      mode: "single",
      agentIds: ["ag_mock_builder"]
    });

    const result = await sendMessage({
      conversationId: conv.id,
      content: "run start test"
    });

    // Check events collected so far for run.start
    for (const event of waiter.events) {
      if (event.type === "run.start") {
        expect(event.runId).toBe(result.runIds[0]);
        expect(event.conversationId).toBe(conv.id);
        expect(event.agentId).toBe("ag_mock_builder");
        unsub();
        return;
      }
    }

    // If not found yet, wait
    const startEvent = await waiter.waitFor("run.start");
    unsub();
    if (startEvent.type === "run.start") {
      expect(startEvent.runId).toBe(result.runIds[0]);
    }
  });

  it("aborts a running agent run", async () => {
    const waiter = createEventWaiter();
    const unsub = waiter.subscribe();

    const conv = createConversation({
      mode: "single",
      agentIds: ["ag_mock_builder"]
    });

    const result = await sendMessage({
      conversationId: conv.id,
      content: "abort me"
    });

    const runId = result.runIds[0];

    // Wait for the run to actually start
    await waiter.waitFor("run.start");

    expect(isRunActive(runId)).toBe(true);
    const aborted = abortRun(runId);
    expect(aborted).toBe(true);

    const endEvent = await waiter.waitFor("run.end");
    unsub();
    if (endEvent.type === "run.end") {
      expect(endEvent.status).toBe("aborted");
    }

    expect(isRunActive(runId)).toBe(false);
  });

  it("abort returns false for unknown run id", () => {
    expect(abortRun("run_nonexistent")).toBe(false);
  });

  it("isRunActive returns false for unknown run id", () => {
    expect(isRunActive("run_nonexistent")).toBe(false);
  });

  it("creates an error message when the agent is not found", async () => {
    const conv = createConversation({
      mode: "single",
      agentIds: ["ag_mock_builder"]
    });

    const triggerMsg = await sendMessage({
      conversationId: conv.id,
      content: "this should fail"
    });

    // Collect events for the error run
    const collected: StreamEvent[] = [];
    const unsub = eventBus.subscribe((entry) => {
      collected.push(entry.event);
    });

    startAgentRun({
      conversationId: conv.id,
      agentId: "ag_nonexistent",
      triggerMessage: triggerMsg.message
    });

    // Wait a bit for the error to be processed
    await new Promise((resolve) => setTimeout(resolve, 300));
    unsub();

    const messages = listMessages(conv.id);
    const errorMsg = messages.find((m) => m.role === "system");
    expect(errorMsg).toBeDefined();
    if (errorMsg) {
      const textPart = errorMsg.parts.find((p) => p.type === "text");
      expect(textPart?.type === "text" && textPart.content).toContain("⚠️");
    }
  });

  it("respects event ordering: run.start → message.start → part events → run.end", async () => {
    const waiter = createEventWaiter();
    const unsub = waiter.subscribe();

    const conv = createConversation({
      mode: "single",
      agentIds: ["ag_mock_builder"]
    });

    await sendMessage({
      conversationId: conv.id,
      content: "order test"
    });

    await waiter.waitFor("run.end");
    unsub();

    const types = waiter.events
      .filter((e) => e.conversationId === conv.id ||
        (e.type === "heartbeat"))
      .map((e) => e.type);

    // Filter to only run-related events (skip heartbeats)
    const relevant = waiter.events
      .filter((e) => e.conversationId === conv.id)
      .map((e) => e.type);

    const runStartIdx = relevant.indexOf("run.start");
    const msgStartIdx = relevant.indexOf("message.start");
    const partStartIdx = relevant.findIndex((t) => t === "part.start");
    const runEndIdx = relevant.lastIndexOf("run.end");

    expect(runStartIdx).toBeGreaterThan(-1);
    expect(msgStartIdx).toBeGreaterThan(-1);
    expect(partStartIdx).toBeGreaterThan(-1);
    expect(runEndIdx).toBeGreaterThan(-1);
    expect(runStartIdx).toBeLessThan(msgStartIdx);
    expect(msgStartIdx).toBeLessThan(partStartIdx);
    expect(partStartIdx).toBeLessThan(runEndIdx);
  }, 10000);
});
