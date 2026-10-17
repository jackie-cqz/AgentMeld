export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type SelectNavigationKey = "ArrowUp" | "ArrowDown" | "Home" | "End";

export type SelectState = {
  open: boolean;
  /** Index into the current options array. -1 means "no active option". */
  activeIndex: number;
};

export type SelectAction =
  | { type: "open"; options: readonly SelectOption[]; value: string }
  | { type: "close" }
  | { type: "toggle"; options: readonly SelectOption[]; value: string }
  | { type: "move"; key: SelectNavigationKey; options: readonly SelectOption[] }
  | { type: "highlight"; index: number };

export const INITIAL_SELECT_STATE: SelectState = { open: false, activeIndex: -1 };

export function isSelectable(option: SelectOption | undefined): option is SelectOption {
  return Boolean(option && !option.disabled);
}

export function firstEnabledIndex(options: readonly SelectOption[]): number {
  return options.findIndex(option => !option.disabled);
}

export function lastEnabledIndex(options: readonly SelectOption[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index].disabled) return index;
  }
  return -1;
}

/** Skip disabled options and wrap around. Returns -1 when nothing can be focused. */
export function nextEnabledIndex(options: readonly SelectOption[], from: number, step: 1 | -1): number {
  if (!options.length) return -1;
  let index = from;
  for (let attempt = 0; attempt < options.length; attempt += 1) {
    index = index < 0
      ? (step > 0 ? 0 : options.length - 1)
      : (index + step + options.length) % options.length;
    if (!options[index].disabled) return index;
  }
  return -1;
}

/** The option the listbox should highlight as soon as it opens. */
export function initialActiveIndex(options: readonly SelectOption[], value: string): number {
  const selected = options.findIndex(option => option.value === value && !option.disabled);
  return selected >= 0 ? selected : firstEnabledIndex(options);
}

export function activeIndexForMove(options: readonly SelectOption[], activeIndex: number, key: SelectNavigationKey): number {
  if (key === "Home") return firstEnabledIndex(options);
  if (key === "End") return lastEnabledIndex(options);
  return nextEnabledIndex(options, activeIndex, key === "ArrowDown" ? 1 : -1);
}

/**
 * Pure open/close + highlight state machine. Keeping it out of the component
 * makes the keyboard behaviour testable in the node (non-jsdom) test runner.
 */
export function reduceSelectState(state: SelectState, action: SelectAction): SelectState {
  switch (action.type) {
    case "open":
      return state.open ? state : { open: true, activeIndex: initialActiveIndex(action.options, action.value) };
    case "toggle":
      return state.open
        ? { open: false, activeIndex: state.activeIndex }
        : { open: true, activeIndex: initialActiveIndex(action.options, action.value) };
    case "close":
      return state.open ? { open: false, activeIndex: state.activeIndex } : state;
    case "move":
      return state.open
        ? { open: true, activeIndex: activeIndexForMove(action.options, state.activeIndex, action.key) }
        : state;
    case "highlight":
      return state.open && action.index >= 0
        ? { open: true, activeIndex: action.index }
        : state;
  }
}
