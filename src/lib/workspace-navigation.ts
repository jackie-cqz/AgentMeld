type Navigation = () => void;
let guard: ((navigate: Navigation) => void) | null = null;

// Only an unsaved workspace editor installs a guard. Normal navigation stays synchronous.
export function requestWorkspaceNavigation(navigate: Navigation) {
  if (guard) guard(navigate);
  else navigate();
}

export function registerWorkspaceGuard(next: (navigate: Navigation) => void) {
  guard = next;
  return () => { if (guard === next) guard = null; };
}
