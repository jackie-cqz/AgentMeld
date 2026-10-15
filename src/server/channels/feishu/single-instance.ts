import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One live connection per app, across processes.
 *
 * The registry already stops one process from connecting the same app twice, but
 * it is in-memory: a second `pnpm dev` against the same credentials knows nothing
 * about the first, and if the platform splits events between the two sockets,
 * each process sees half the messages (or, with separate databases, both answer
 * the same message). The lock lives in the data directory, so two instances
 * pointed at the same data see each other; instances with different data
 * directories are deliberately allowed to race, because that is also how two
 * people can run separate copies of the app.
 *
 * The pid is written into the file so a lock left behind by a crash can be
 * recognised as stale instead of blocking the app forever.
 */
export interface LockHandle {
  appId: string;
  path: string;
  release: () => void;
}

export type LockOutcome =
  | { ok: true; handle: LockHandle }
  | { ok: false; reason: string; holderPid: number | null };

function lockPath(dataDir: string, appId: string): string {
  // The app id is an opaque identifier from the platform, but it reaches a file
  // name here, so anything that is not plainly safe is encoded.
  const safe = /^[A-Za-z0-9_-]+$/.test(appId) ? appId : Buffer.from(appId).toString("hex");
  return path.join(dataDir, `feishu-${safe}.lock`);
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPid(file: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

/**
 * Take the lock for one app, or report who holds it.
 *
 * `wx` is the whole atomicity: creating the file is the test AND the claim, so
 * two processes starting at once cannot both succeed.
 */
export function acquireFeishuAppLock(appId: string, dataDir: string): LockOutcome {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = lockPath(dataDir, appId);
  const payload = JSON.stringify({ appId, pid: process.pid, host: os.hostname(), at: Date.now() });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, payload);
      return {
        ok: true,
        handle: {
          appId,
          path: file,
          release: () => {
            try {
              fs.closeSync(fd);
            } catch {
              // Already closed.
            }
            try {
              // Only remove OUR file: a stale lock taken over by someone else
              // must not be deleted by the process that lost it.
              if (readPid(file) === process.pid) fs.rmSync(file, { force: true });
            } catch {
              // Nothing useful to do; the file is only a hint with a pid in it.
            }
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return { ok: false, reason: `could not take the app lock: ${String(error)}`, holderPid: null };
      }
      const holder = readPid(file);
      if (holder !== null && isAlive(holder)) {
        return {
          ok: false,
          reason: `another AgentMeld process (pid ${holder}) already connects this app`,
          holderPid: holder
        };
      }
      // Stale (or unreadable): take it over. A crash must not lock the app out.
      try {
        fs.rmSync(file, { force: true });
      } catch {
        return { ok: false, reason: "could not clear a stale app lock", holderPid: holder };
      }
    }
  }
  return { ok: false, reason: "could not take the app lock", holderPid: readPid(file) };
}
