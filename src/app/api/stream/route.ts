import { eventBus, type EventBusEntry } from "@/server/event-bus";
import type { StreamEvent } from "@/shared/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const encoder = new TextEncoder();
const HEARTBEAT_MS = 15000;
const RETRY_MS = 2000;

export async function GET(request: Request) {
  const lastEventId = parseLastEventId(request.headers.get("last-event-id"));

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const send = (entry: EventBusEntry) => {
        write(encodeSse(entry.id, entry.event));
      };

      write(`retry: ${RETRY_MS}\n\n`);
      write(": connected\n\n");

      const unsubscribe = eventBus.subscribe(send, {
        replayAfterId: lastEventId
      });

      const heartbeat = setInterval(() => {
        const event: StreamEvent = {
          type: "heartbeat",
          conversationId: "*",
          timestamp: Date.now()
        };
        const id = eventBus.lastEventId();
        write(encodeSse(id, event));
      }, HEARTBEAT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // The runtime may already have closed the stream.
        }
      };

      request.signal.addEventListener("abort", cleanup, { once: true });
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}

function encodeSse(id: number, event: StreamEvent) {
  return `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}

function parseLastEventId(value: string | null) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
