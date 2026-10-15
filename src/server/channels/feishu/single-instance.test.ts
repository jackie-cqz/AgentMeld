import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFeishuAppLock } from "@/server/channels/feishu/single-instance";

/**
 * One live connection per app across processes.
 *
 * Two `pnpm dev` instances with the same credentials know nothing about each
 * other through the in-memory registry, and if the platform splits events
 * between their sockets each sees half the messages. The lock is a file in the
 * data directory: creating it IS the claim, so two processes starting at once
 * cannot both win, and the pid inside it means a crash does not lock the app out.
 */
const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-lock-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the app lock", () => {
  it("lets one holder in and reports the other", () => {
    const dir = tempDir();
    const first = acquireFeishuAppLock("cli_a", dir);
    expect(first.ok).toBe(true);

    const second = acquireFeishuAppLock("cli_a", dir);

    expect(second.ok).toBe(false);
    if (second.ok) return;
    // The holder is a live process — this one — so the refusal is real.
    expect(second.holderPid).toBe(process.pid);
    expect(second.reason).toContain("another AgentMeld process");
  });

  it("keeps different apps independent", () => {
    const dir = tempDir();
    expect(acquireFeishuAppLock("cli_a", dir).ok).toBe(true);
    expect(acquireFeishuAppLock("cli_b", dir).ok).toBe(true);
  });

  it("lets go on release, so the app can be taken over", () => {
    const dir = tempDir();
    const first = acquireFeishuAppLock("cli_a", dir);
    if (!first.ok) throw new Error("expected the first lock");

    first.handle.release();

    expect(acquireFeishuAppLock("cli_a", dir).ok).toBe(true);
  });

  it("takes over a lock whose process is gone", () => {
    const dir = tempDir();
    // A pid that cannot be running: released only after being written, and the
    // lock file is all that is left of it.
    const stale = path.join(dir, "feishu-cli_a.lock");
    fs.writeFileSync(stale, JSON.stringify({ appId: "cli_a", pid: 2 ** 30, at: Date.now() }));

    const taken = acquireFeishuAppLock("cli_a", dir);

    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(JSON.parse(fs.readFileSync(stale, "utf-8")).pid).toBe(process.pid);
  });

  it("does not delete a lock somebody else now holds", () => {
    const dir = tempDir();
    const first = acquireFeishuAppLock("cli_a", dir);
    if (!first.ok) throw new Error("expected the first lock");
    // Someone else took over (as if this process had been declared stale).
    fs.writeFileSync(path.join(dir, "feishu-cli_a.lock"), JSON.stringify({ pid: 2 ** 30 }));

    first.handle.release();

    expect(fs.existsSync(path.join(dir, "feishu-cli_a.lock"))).toBe(true);
  });

  it("encodes an app id that is not a plain file name", () => {
    const dir = tempDir();
    const odd = acquireFeishuAppLock("cli/../etc", dir);
    expect(odd.ok).toBe(true);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^feishu-[0-9a-f]+\.lock$/);
  });
});
