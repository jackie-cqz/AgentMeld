import type { StreamEvent } from "@/shared/types";

type Listener = (entry: EventBusEntry) => void;

export interface EventBusEntry {
  id: number;
  event: StreamEvent;
}

const MAX_REPLAY_EVENTS = 500;

export class EventBus {
  private listeners = new Set<Listener>();
  private entries: EventBusEntry[] = [];
  private nextId = 1;

  subscribe(listener: Listener, options?: { replayAfterId?: number }) {
    this.listeners.add(listener);

    if (typeof options?.replayAfterId === "number") {
      for (const entry of this.replayAfter(options.replayAfterId)) {
        listener(entry);
      }
    }

    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: StreamEvent) {
    const entry: EventBusEntry = {
      id: this.nextId,
      event
    };
    this.nextId += 1;

    this.entries.push(entry);
    if (this.entries.length > MAX_REPLAY_EVENTS) {
      this.entries.splice(0, this.entries.length - MAX_REPLAY_EVENTS);
    }

    for (const listener of this.listeners) {
      listener(entry);
    }

    return entry;
  }

  replayAfter(id: number) {
    return this.entries.filter((entry) => entry.id > id);
  }

  listenerCount() {
    return this.listeners.size;
  }

  lastEventId() {
    return this.nextId - 1;
  }

  clearForTests() {
    this.listeners.clear();
    this.entries = [];
    this.nextId = 1;
  }
}

declare global {
  var __agentConferenceEventBus: EventBus | undefined;
}

export const eventBus = globalThis.__agentConferenceEventBus ?? new EventBus();
globalThis.__agentConferenceEventBus = eventBus;
