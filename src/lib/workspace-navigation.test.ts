import { describe, expect, it } from "vitest";
import { registerWorkspaceGuard, requestWorkspaceNavigation } from "./workspace-navigation";

describe("workspace navigation guard", () => {
  it("keeps ordinary navigation synchronous", () => {
    let count = 0;
    requestWorkspaceNavigation(() => count++);
    expect(count).toBe(1);
  });

  it("defers navigation until the editor confirms", () => {
    let pending: (() => void) | undefined;
    let count = 0;
    const cleanup = registerWorkspaceGuard(navigate => { pending = navigate; });
    requestWorkspaceNavigation(() => count++);
    expect(count).toBe(0);
    cleanup();
    pending?.();
    expect(count).toBe(1);
    requestWorkspaceNavigation(() => count++);
    expect(count).toBe(2);
  });

  it("does not let an old editor cleanup unregister a newer editor", () => {
    const previous = registerWorkspaceGuard(() => {});
    let intercepted = false;
    const current = registerWorkspaceGuard(() => { intercepted = true; });
    previous();
    requestWorkspaceNavigation(() => { throw new Error("Unexpected unguarded navigation"); });
    expect(intercepted).toBe(true);
    current();
  });
});
