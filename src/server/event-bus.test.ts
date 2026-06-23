import { describe, expect, it } from "vitest";
import { EventBus } from "@/server/event-bus";

describe("EventBus", () => {
  it("publishes events to subscribers with monotonic ids", () => {
    const bus = new EventBus();
    const received: number[] = [];

    const unsubscribe = bus.subscribe((entry) => {
      received.push(entry.id);
    });

    bus.publish({ type: "heartbeat", conversationId: "*", timestamp: 1 });
    bus.publish({ type: "heartbeat", conversationId: "*", timestamp: 2 });

    expect(received).toEqual([1, 2]);
    expect(bus.lastEventId()).toBe(2);
    expect(bus.listenerCount()).toBe(1);

    unsubscribe();
    expect(bus.listenerCount()).toBe(0);
  });

  it("replays buffered events after a last event id", () => {
    const bus = new EventBus();
    bus.publish({ type: "heartbeat", conversationId: "*", timestamp: 1 });
    bus.publish({ type: "heartbeat", conversationId: "*", timestamp: 2 });
    bus.publish({ type: "heartbeat", conversationId: "*", timestamp: 3 });

    const replayed: number[] = [];
    bus.subscribe(
      (entry) => {
        replayed.push(entry.id);
      },
      { replayAfterId: 1 }
    );

    expect(replayed).toEqual([2, 3]);
  });
});
