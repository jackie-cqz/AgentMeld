import { describe, expect, it } from "vitest";
import {
  INITIAL_SELECT_STATE,
  activeIndexForMove,
  firstEnabledIndex,
  initialActiveIndex,
  lastEnabledIndex,
  nextEnabledIndex,
  reduceSelectState,
  type SelectOption
} from "./select-logic";

const options: SelectOption[] = [
  { value: "review", label: "Review · 手动审批" },
  { value: "auto", label: "Auto · 自动审批", disabled: true },
  { value: "raw", label: "原文 · 原始消息" },
  { value: "evidence", label: "证据 · 已核实事实", disabled: true },
  { value: "other", label: "其他" }
];

describe("select navigation helpers", () => {
  it("finds the first and last enabled option", () => {
    expect(firstEnabledIndex(options)).toBe(0);
    expect(lastEnabledIndex(options)).toBe(4);
    expect(firstEnabledIndex([{ value: "a", label: "A", disabled: true }])).toBe(-1);
    expect(lastEnabledIndex([])).toBe(-1);
  });

  it("skips disabled options and wraps in both directions", () => {
    expect(nextEnabledIndex(options, 0, 1)).toBe(2);
    expect(nextEnabledIndex(options, 2, 1)).toBe(4);
    expect(nextEnabledIndex(options, 4, 1)).toBe(0);
    expect(nextEnabledIndex(options, 0, -1)).toBe(4);
    expect(nextEnabledIndex(options, 2, -1)).toBe(0);
    expect(nextEnabledIndex(options, 4, -1)).toBe(2);
  });

  it("starts from the ends when there is no active option", () => {
    expect(nextEnabledIndex(options, -1, 1)).toBe(0);
    expect(nextEnabledIndex(options, -1, -1)).toBe(4);
    expect(nextEnabledIndex([], -1, 1)).toBe(-1);
    expect(nextEnabledIndex([{ value: "a", label: "A", disabled: true }], -1, 1)).toBe(-1);
  });

  it("uses the selected value when it is selectable, otherwise the first enabled option", () => {
    expect(initialActiveIndex(options, "raw")).toBe(2);
    expect(initialActiveIndex(options, "auto")).toBe(0);
    expect(initialActiveIndex(options, "missing")).toBe(0);
    expect(initialActiveIndex(options, "")).toBe(0);
  });

  it("maps Home/End/arrows to an enabled index", () => {
    expect(activeIndexForMove(options, 2, "Home")).toBe(0);
    expect(activeIndexForMove(options, 2, "End")).toBe(4);
    expect(activeIndexForMove(options, 0, "ArrowDown")).toBe(2);
    expect(activeIndexForMove(options, 2, "ArrowUp")).toBe(0);
    expect(activeIndexForMove(options, -1, "ArrowDown")).toBe(0);
    expect(activeIndexForMove(options, -1, "ArrowUp")).toBe(4);
  });
});

describe("select state transitions", () => {
  it("opens on the selected option and resets the highlight each time it opens", () => {
    const opened = reduceSelectState(INITIAL_SELECT_STATE, { type: "open", options, value: "raw" });
    expect(opened).toEqual({ open: true, activeIndex: 2 });
    const moved = reduceSelectState(opened, { type: "move", key: "ArrowDown", options });
    expect(moved).toEqual({ open: true, activeIndex: 4 });
    const closed = reduceSelectState(moved, { type: "close" });
    expect(closed).toEqual({ open: false, activeIndex: 4 });
    expect(reduceSelectState(closed, { type: "open", options, value: "raw" })).toEqual({ open: true, activeIndex: 2 });
  });

  it("toggles open state and keeps the highlight when closing", () => {
    const opened = reduceSelectState(INITIAL_SELECT_STATE, { type: "toggle", options, value: "review" });
    expect(opened).toEqual({ open: true, activeIndex: 0 });
    const highlighted = reduceSelectState(opened, { type: "highlight", index: 4 });
    expect(highlighted).toEqual({ open: true, activeIndex: 4 });
    expect(reduceSelectState(highlighted, { type: "toggle", options, value: "review" })).toEqual({ open: false, activeIndex: 4 });
  });

  it("ignores movement and highlighting while closed and leaves state stable", () => {
    expect(reduceSelectState(INITIAL_SELECT_STATE, { type: "move", key: "ArrowDown", options })).toBe(INITIAL_SELECT_STATE);
    expect(reduceSelectState(INITIAL_SELECT_STATE, { type: "highlight", index: 3 })).toBe(INITIAL_SELECT_STATE);
    expect(reduceSelectState(INITIAL_SELECT_STATE, { type: "close" })).toBe(INITIAL_SELECT_STATE);
    expect(reduceSelectState(INITIAL_SELECT_STATE, { type: "open", options, value: "raw" })).not.toBe(INITIAL_SELECT_STATE);
  });

  it("does not reopen an already open listbox during a second open action", () => {
    const opened = reduceSelectState(INITIAL_SELECT_STATE, { type: "open", options, value: "other" });
    const highlighted = reduceSelectState(opened, { type: "highlight", index: 2 });
    expect(reduceSelectState(highlighted, { type: "open", options, value: "other" })).toBe(highlighted);
  });
});
