import { StringDecoder } from "node:string_decoder";

export type PiRecord = Record<string, unknown> & { type: string };

/** Pi 0.84.2 uses LF-delimited JSON, not Unicode-aware line splitting. */
export class PiJsonLines {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";

  constructor(private readonly maxFrameBytes = 8 * 1024 * 1024) {}

  push(chunk: Buffer): PiRecord[] {
    this.pending += this.decoder.write(chunk);
    const records: PiRecord[] = [];
    for (;;) {
      const end = this.pending.indexOf("\n");
      if (end < 0) break;
      const line = this.pending.slice(0, end).replace(/\r$/, "");
      this.pending = this.pending.slice(end + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) throw new Error("Pi protocol frame exceeds its byte limit.");
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as PiRecord).type !== "string") {
        throw new Error("Pi sent an invalid protocol record.");
      }
      records.push(value as PiRecord);
    }
    if (Buffer.byteLength(this.pending, "utf8") > this.maxFrameBytes) throw new Error("Pi protocol frame exceeds its byte limit.");
    return records;
  }

  finish(): void {
    this.pending += this.decoder.end();
    if (this.pending.trim()) throw new Error("Pi closed stdout with an incomplete protocol frame.");
  }
}

export function encodePiCommand(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

export class PiEventQueue implements AsyncIterable<PiRecord> {
  private values: PiRecord[] = [];
  private notify: (() => void) | null = null;
  private done = false;
  private failure: Error | null = null;

  push(value: PiRecord): void {
    if (this.done) return;
    if (this.values.length >= 10000) {
      this.end(new Error("Pi event consumer exceeded its bounded queue."));
      return;
    }
    this.values.push(value);
    this.notify?.();
  }

  end(error?: Error): void {
    this.done = true;
    this.failure ??= error ?? null;
    this.notify?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<PiRecord> {
    for (;;) {
      const value = this.values.shift();
      if (value) { yield value; continue; }
      if (this.failure) throw this.failure;
      if (this.done) return;
      await new Promise<void>((resolve) => { this.notify = resolve; });
      this.notify = null;
    }
  }
}
