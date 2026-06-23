import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eventBus } from "@/server/event-bus";
import { setupTestDatabase } from "@/test/test-database";
import {
  approvePendingWrite,
  cancelPendingWritesForRun,
  clearPendingWritesForTests,
  getAllPendingWrites,
  getPendingWrite,
  getPendingWritesForConversation,
  registerPendingWrite,
  rejectPendingWrite
} from "@/server/pending-writes";
import {
  approvePendingBash,
  cancelPendingBashForRun,
  clearPendingBashForTests,
  getAllPendingBashCommands,
  getPendingBashCommandsForConversation,
  registerPendingBash,
  rejectPendingBash
} from "@/server/pending-bash";

let cleanupDatabase: (() => void) | undefined;

beforeAll(() => {
  cleanupDatabase = setupTestDatabase("agentmeld-pending-queues-");
});

afterAll(() => {
  cleanupDatabase?.();
});

beforeEach(() => {
  eventBus.clearForTests();
  clearPendingWritesForTests();
  clearPendingBashForTests();
});

afterEach(() => {
  clearPendingWritesForTests();
  clearPendingBashForTests();
  eventBus.clearForTests();
});

describe("pending-writes", () => {
  it("registers a pending write and returns a promise", () => {
    const promise = registerPendingWrite("conv_write_1", "ag_1", "run_write_1", "test.txt", "/ws/test.txt", null, "new content");
    expect(promise).toBeInstanceOf(Promise);
  });

  it("publishes a pending event when a write requires approval", () => {
    registerPendingWrite(
      "conv_write_1",
      "ag_1",
      "run_write_1",
      "test.txt",
      "/ws/test.txt",
      null,
      "new content"
    );

    const [entry] = eventBus.replayAfter(0);
    expect(entry.event.type).toBe("fs_write.pending");
    if (entry.event.type === "fs_write.pending") {
      expect(entry.event.pendingWrite.path).toBe("test.txt");
      expect(entry.event.conversationId).toBe("conv_write_1");
    }
  });

  it("lists all registered writes", () => {
    registerPendingWrite("conv_write_1", "ag_1", "run_write_1", "a.txt", "/ws/a.txt", null, "x");
    registerPendingWrite("conv_write_2", "ag_2", "run_write_2", "b.txt", "/ws/b.txt", null, "y");

    const all = getAllPendingWrites();
    expect(all).toHaveLength(2);
  });

  it("filters writes by conversation", () => {
    registerPendingWrite("conv_write_1", "ag_1", "run_write_1", "a.txt", "/ws/a.txt", null, "x");
    registerPendingWrite("conv_write_2", "ag_2", "run_write_2", "b.txt", "/ws/b.txt", null, "y");

    const filtered = getPendingWritesForConversation("conv_write_1");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].path).toBe("a.txt");
  });

  it("approval resolves the promise with true", async () => {
    const promise = registerPendingWrite("conv_write_1", "ag_1", "run_write_1", "test.txt", "/ws/test.txt", null, "content");

    // Resolve in next tick
    setTimeout(() => {
      const all = getAllPendingWrites();
      approvePendingWrite(all[0].id);
    }, 10);

    const result = await promise;
    expect(result).toBe(true);
    expect(getAllPendingWrites()).toHaveLength(0);
  });

  it("allows a pending write to be resolved only once", async () => {
    const promise = registerPendingWrite("conv_write_1", "ag_1", "run_write_1", "test.txt", "/ws/test.txt", null, "content");
    const id = getAllPendingWrites()[0].id;

    expect(approvePendingWrite(id)).toBe(true);
    expect(rejectPendingWrite(id)).toBe(false);
    await expect(promise).resolves.toBe(true);
  });

  it("rejection resolves the promise with false", async () => {
    const promise = registerPendingWrite("conv_write_1", "ag_1", "run_write_1", "test.txt", "/ws/test.txt", null, "content");

    setTimeout(() => {
      const all = getAllPendingWrites();
      rejectPendingWrite(all[0].id);
    }, 10);

    const result = await promise;
    expect(result).toBe(false);
  });

  it("getPendingWrite returns undefined for unknown id", () => {
    expect(getPendingWrite("nonexistent")).toBeUndefined();
  });

  it("cancelPendingWritesForRun removes all writes for a run", () => {
    registerPendingWrite("conv_write_1", "ag_1", "run_write_1", "a.txt", "/ws/a.txt", null, "x");
    registerPendingWrite("conv_write_1", "ag_1", "run_write_1", "b.txt", "/ws/b.txt", null, "y");
    registerPendingWrite("conv_write_1", "ag_1", "run_write_2", "c.txt", "/ws/c.txt", null, "z");

    cancelPendingWritesForRun("run_write_1");
    expect(getAllPendingWrites()).toHaveLength(1);
  });
});

describe("pending-bash", () => {
  it("registers a pending bash command", () => {
    const promise = registerPendingBash("conv_bash_1", "ag_1", "run_bash_1", "npm install", "/ws", "Installing dependencies");
    expect(promise).toBeInstanceOf(Promise);
  });

  it("lists all registered bash commands", () => {
    registerPendingBash("conv_bash_1", "ag_1", "run_bash_1", "npm install", "/ws", "Dep install");
    registerPendingBash("conv_bash_2", "ag_2", "run_bash_2", "git reset", "/ws2", "Reset");

    expect(getAllPendingBashCommands()).toHaveLength(2);
  });

  it("filters bash commands by conversation", () => {
    registerPendingBash("conv_bash_1", "ag_1", "run_bash_1", "npm install", "/ws", "Dep");
    registerPendingBash("conv_bash_2", "ag_2", "run_bash_2", "pip install", "/ws2", "Pip");

    const filtered = getPendingBashCommandsForConversation("conv_bash_2");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].command).toBe("pip install");
  });

  it("approval resolves the promise with true", async () => {
    const promise = registerPendingBash("conv_bash_1", "ag_1", "run_bash_1", "npm install", "/ws", "Reason");

    setTimeout(() => {
      const all = getAllPendingBashCommands();
      approvePendingBash(all[0].id);
    }, 10);

    const result = await promise;
    expect(result).toBe(true);
  });

  it("allows a pending bash command to be resolved only once", async () => {
    const promise = registerPendingBash("conv_bash_1", "ag_1", "run_bash_1", "npm install", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    expect(approvePendingBash(id)).toBe(true);
    expect(rejectPendingBash(id)).toBe(false);
    await expect(promise).resolves.toBe(true);
  });

  it("rejection resolves the promise with false", async () => {
    const promise = registerPendingBash("conv_bash_1", "ag_1", "run_bash_1", "rm -rf node_modules", "/ws", "Clean");

    setTimeout(() => {
      const all = getAllPendingBashCommands();
      rejectPendingBash(all[0].id);
    }, 10);

    const result = await promise;
    expect(result).toBe(false);
  });

  it("cancelPendingBashForRun removes bash commands for a run", () => {
    registerPendingBash("conv_bash_1", "ag_1", "run_bash_1", "cmd1", "/ws", "r1");
    registerPendingBash("conv_bash_1", "ag_1", "run_bash_1", "cmd2", "/ws", "r2");
    registerPendingBash("conv_bash_1", "ag_1", "run_bash_2", "cmd3", "/ws", "r3");

    cancelPendingBashForRun("run_bash_1");
    expect(getAllPendingBashCommands()).toHaveLength(1);
  });
});
