import { afterEach, describe, expect, it } from "vitest";
import { getAdapter, registerAdapter, clearRegistryForTests } from "@/server/adapters/registry";
import type { AgentPlatformAdapter, AdapterInput } from "@/server/adapters/types";
import type { StreamEvent } from "@/shared/types";

afterEach(() => {
  clearRegistryForTests();
});

describe("adapter registry", () => {
  it("returns the mock adapter by name", () => {
    const adapter = getAdapter("mock");
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("mock");
  });

  it("throws for an unknown adapter name", () => {
    expect(() => getAdapter("unknown-adapter" as never)).toThrow("Unknown adapter");
  });

  it("allows registering a custom adapter", () => {
    const custom: AgentPlatformAdapter = {
      name: "mock",
      async *run(_input: AdapterInput, _signal: AbortSignal): AsyncGenerator<StreamEvent> {
        yield { type: "heartbeat", conversationId: "*", timestamp: 1 };
      }
    };

    registerAdapter(custom);
    const adapter = getAdapter("mock");
    expect(adapter).toBe(custom);
  });
});
