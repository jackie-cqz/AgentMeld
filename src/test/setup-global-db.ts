import { afterAll, beforeAll } from "vitest";

// Runs once per test file (vitest `setupFiles`). Repository helpers assume a
// bootstrapped database, so give every file an isolated, already-migrated
// SQLite database without requiring each suite to wire one up. Files that need
// tighter control can still call `setupTestDatabase` themselves.
//
// The import is deferred to `beforeAll` on purpose: the bootstrap graph pulls in
// `run-recovery` -> `dispatch-tool-evidence` -> `evidence-repository`, so
// importing it while setup files are evaluated would load those modules before
// a test file's `vi.mock` calls are registered and break its mocks.
let cleanup: (() => void) | undefined;

beforeAll(async () => {
  const { setupTestDatabase } = await import("@/test/test-database");
  cleanup = setupTestDatabase("agentmeld-vitest-");
});

afterAll(() => {
  cleanup?.();
});
