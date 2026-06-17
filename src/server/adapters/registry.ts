import type { AdapterName } from "@/shared/types";
import type { AgentPlatformAdapter } from "@/server/adapters/types";
import { mockAdapter } from "@/server/adapters/mock-adapter";
import { customAgentAdapter } from "@/server/adapters/custom-agent-adapter";

const adapters = new Map<AdapterName, AgentPlatformAdapter>();

function buildRegistry(): Map<AdapterName, AgentPlatformAdapter> {
  const map = new Map<AdapterName, AgentPlatformAdapter>();
  map.set(mockAdapter.name, mockAdapter);
  map.set(customAgentAdapter.name, customAgentAdapter);
  return map;
}

export function getAdapter(name: AdapterName): AgentPlatformAdapter {
  if (adapters.size === 0) {
    for (const [key, value] of buildRegistry()) {
      adapters.set(key, value);
    }
  }
  const adapter = adapters.get(name);
  if (!adapter) {
    throw new Error(`Unknown adapter: ${name}`);
  }
  return adapter;
}

export function registerAdapter(adapter: AgentPlatformAdapter): void {
  if (adapters.size === 0) {
    for (const [key, value] of buildRegistry()) {
      adapters.set(key, value);
    }
  }
  adapters.set(adapter.name, adapter);
}

export function clearRegistryForTests(): void {
  adapters.clear();
}
