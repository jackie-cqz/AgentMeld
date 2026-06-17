import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  getPendingBash,
  getPendingBashCommandsForConversation,
  registerPendingBash,
  rejectPendingBash
} from "@/server/pending-bash";

beforeEach(() => {
  clearPendingWritesForTests();
  clearPendingBashForTests();
});

afterEach(() => {
  clearPendingWritesForTests();
  clearPendingBashForTests();
});

describe("pending-writes", () => {
  it("registers a pending write and returns a promise", () => {
    const promise = registerPendingWrite("conv_1", "ag_1", "run_1", "test.txt", "/ws/test.txt", null, "new content");
    expect(promise).toBeInstanceOf(Promise);
  });

  it("lists all registered writes", () => {
    registerPendingWrite("conv_1", "ag_1", "run_1", "a.txt", "/ws/a.txt", null, "x");
    registerPendingWrite("conv_2", "ag_2", "run_2", "b.txt", "/ws/b.txt", null, "y");

    const all = getAllPendingWrites();
    expect(all).toHaveLength(2);
  });

  it("filters writes by conversation", () => {
    registerPendingWrite("conv_1", "ag_1", "run_1", "a.txt", "/ws/a.txt", null, "x");
    registerPendingWrite("conv_2", "ag_2", "run_2", "b.txt", "/ws/b.txt", null, "y");

    const filtered = getPendingWritesForConversation("conv_1");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].path).toBe("a.txt");
  });

  it("approval resolves the promise with true", async () => {
    const promise = registerPendingWrite("conv_1", "ag_1", "run_1", "test.txt", "/ws/test.txt", null, "content");

    // Resolve in next tick
    setTimeout(() => {
      const all = getAllPendingWrites();
      approvePendingWrite(all[0].id);
    }, 10);

    const result = await promise;
    expect(result).toBe(true);
    expect(getAllPendingWrites()).toHaveLength(0);
  });

  it("rejection resolves the promise with false", async () => {
    const promise = registerPendingWrite("conv_1", "ag_1", "run_1", "test.txt", "/ws/test.txt", null, "content");

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
    registerPendingWrite("conv_1", "ag_1", "run_1", "a.txt", "/ws/a.txt", null, "x");
    registerPendingWrite("conv_1", "ag_1", "run_1", "b.txt", "/ws/b.txt", null, "y");
    registerPendingWrite("conv_1", "ag_1", "run_2", "c.txt", "/ws/c.txt", null, "z");

    cancelPendingWritesForRun("run_1");
    expect(getAllPendingWrites()).toHaveLength(1);
  });
});

describe("pending-bash", () => {
  it("registers a pending bash command", () => {
    const promise = registerPendingBash("conv_1", "ag_1", "run_1", "npm install", "/ws", "Installing dependencies");
    expect(promise).toBeInstanceOf(Promise);
  });

  it("lists all registered bash commands", () => {
    registerPendingBash("conv_1", "ag_1", "run_1", "npm install", "/ws", "Dep install");
    registerPendingBash("conv_2", "ag_2", "run_2", "git reset", "/ws2", "Reset");

    expect(getAllPendingBashCommands()).toHaveLength(2);
  });

  it("filters bash commands by conversation", () => {
    registerPendingBash("conv_1", "ag_1", "run_1", "npm install", "/ws", "Dep");
    registerPendingBash("conv_2", "ag_2", "run_2", "pip install", "/ws2", "Pip");

    const filtered = getPendingBashCommandsForConversation("conv_2");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].command).toBe("pip install");
  });

  it("approval resolves the promise with true", async () => {
    const promise = registerPendingBash("conv_1", "ag_1", "run_1", "npm install", "/ws", "Reason");

    setTimeout(() => {
      const all = getAllPendingBashCommands();
      approvePendingBash(all[0].id);
    }, 10);

    const result = await promise;
    expect(result).toBe(true);
  });

  it("rejection resolves the promise with false", async () => {
    const promise = registerPendingBash("conv_1", "ag_1", "run_1", "rm -rf node_modules", "/ws", "Clean");

    setTimeout(() => {
      const all = getAllPendingBashCommands();
      rejectPendingBash(all[0].id);
    }, 10);

    const result = await promise;
    expect(result).toBe(false);
  });

  it("cancelPendingBashForRun removes bash commands for a run", () => {
    registerPendingBash("conv_1", "ag_1", "run_1", "cmd1", "/ws", "r1");
    registerPendingBash("conv_1", "ag_1", "run_1", "cmd2", "/ws", "r2");
    registerPendingBash("conv_1", "ag_1", "run_2", "cmd3", "/ws", "r3");

    cancelPendingBashForRun("run_1");
    expect(getAllPendingBashCommands()).toHaveLength(1);
  });
});
