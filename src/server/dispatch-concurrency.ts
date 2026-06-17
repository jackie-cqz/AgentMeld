const MAX_CONCURRENT_SUB_RUNS = 3;

interface Waiter {
  resolve: () => void;
  abort: () => void;
}

let active = 0;
const queue: Waiter[] = [];

export async function acquireConcurrencySlot(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) {
    throw new Error("Aborted before acquiring concurrency slot.");
  }

  if (active < MAX_CONCURRENT_SUB_RUNS) {
    active++;
    return () => releaseSlot();
  }

  return new Promise<() => void>((resolve, reject) => {
    const onAbort = () => {
      const idx = queue.findIndex((w) => w.resolve === resolve);
      if (idx >= 0) queue.splice(idx, 1);
      reject(new Error("Aborted while waiting for concurrency slot."));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    queue.push({
      resolve: () => {
        signal.removeEventListener("abort", onAbort);
        active++;
        resolve(() => releaseSlot());
      },
      abort: onAbort
    });

    drainQueue();
  });
}

function releaseSlot(): void {
  active--;
  drainQueue();
}

function drainQueue(): void {
  while (active < MAX_CONCURRENT_SUB_RUNS && queue.length > 0) {
    const waiter = queue.shift()!;
    waiter.resolve();
  }
}

export function getActiveConcurrencyCount(): number {
  return active;
}

export function resetConcurrencyForTests(): void {
  active = 0;
  queue.length = 0;
}
