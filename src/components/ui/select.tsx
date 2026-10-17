"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  INITIAL_SELECT_STATE,
  reduceSelectState,
  type SelectNavigationKey,
  type SelectOption
} from "./select-logic";

export type { SelectOption };

export type SelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  /** Visible label. When omitted, pass `aria-label` instead. */
  label?: string;
  "aria-label"?: string;
  disabled?: boolean;
  placeholder?: string;
  size?: "sm" | "md";
  className?: string;
};

const subscribe = () => () => {};

/**
 * A controlled, styled replacement for the native <select>. The trigger keeps
 * real DOM focus (aria-activedescendant pattern) so it works inside dialogs and
 * scroll containers; the listbox is portalled to the nearest dialog (or body)
 * and positioned against the trigger with fixed coordinates.
 */
export function Select({
  value,
  onChange,
  options,
  label,
  "aria-label": ariaLabel,
  disabled = false,
  placeholder,
  size = "md",
  className = ""
}: SelectProps) {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const reactId = useId();
  const triggerId = `${reactId}-trigger`;
  const labelId = `${reactId}-label`;
  const listboxId = `${reactId}-listbox`;
  const [state, dispatch] = useReducer(reduceSelectState, INITIAL_SELECT_STATE);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const { open, activeIndex } = state;
  const selected = options.find(option => option.value === value);
  const activeOptionId = open && activeIndex >= 0 && options[activeIndex] ? `${reactId}-option-${activeIndex}` : undefined;

  useLayoutEffect(() => {
    if (!mounted || !open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const place = () => {
      const rect = trigger.getBoundingClientRect();
      const margin = 8;
      const gap = 4;
      const width = Math.max(120, Math.min(Math.max(rect.width, 180), window.innerWidth - margin * 2));
      const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin));
      const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
      const spaceAbove = rect.top - gap - margin;
      const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(96, Math.min(280, openUp ? spaceAbove : spaceBelow));
      menu.style.left = `${left}px`;
      menu.style.width = `${width}px`;
      menu.style.maxHeight = `${maxHeight}px`;
      if (openUp) {
        menu.style.top = "auto";
        menu.style.bottom = `${window.innerHeight - rect.top + gap}px`;
      } else {
        menu.style.bottom = "auto";
        menu.style.top = `${rect.bottom + gap}px`;
      }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [mounted, open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (rootRef.current?.contains(target) || menuRef.current?.contains(target))) return;
      dispatch({ type: "close" });
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [open]);

  useEffect(() => {
    if (!open || !activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
  }, [open, activeOptionId]);

  const openMenu = () => {
    const trigger = triggerRef.current;
    if (trigger) setPortalTarget(trigger.closest("dialog") ?? document.body);
    dispatch({ type: "open", options, value });
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    dispatch({ type: "close" });
    triggerRef.current?.focus({ preventScroll: true });
    if (option.value !== value) onChange(option.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const key = event.key;
    if (key === "Escape") {
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: "close" });
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    if (key === "Tab") {
      if (open) dispatch({ type: "close" });
      return;
    }
    if (key === "Enter" || key === " " || key === "Spacebar") {
      if (open) {
        event.preventDefault();
        choose(activeIndex);
      }
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
      event.preventDefault();
      if (!open) openMenu();
      else dispatch({ type: "move", key: key as SelectNavigationKey, options });
    }
  };

  const classNameRoot = ["ui-select", label ? "ui-select--labelled" : "", size === "sm" ? "ui-select--sm" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={rootRef} className={classNameRoot}>
      {label ? <span className="ui-field-label" id={labelId}>{label}</span> : null}
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        className="ui-select-trigger"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        aria-labelledby={label ? labelId : undefined}
        aria-label={label ? undefined : ariaLabel}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={() => open ? dispatch({ type: "close" }) : openMenu()}
        onKeyDown={handleKeyDown}
      >
        <span className={`ui-select-value${selected ? "" : " is-placeholder"}`}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={size === "sm" ? 14 : 16} aria-hidden="true" />
      </button>
      {mounted && open && portalTarget ? createPortal(
        <ul
          ref={menuRef}
          id={listboxId}
          role="listbox"
          className="ui-select-menu"
          aria-labelledby={label ? labelId : undefined}
          aria-label={label ? undefined : ariaLabel}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;
            return (
              <li
                key={`${option.value}-${index}`}
                id={`${reactId}-option-${index}`}
                role="option"
                data-value={option.value}
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                className={`ui-select-option${isActive ? " is-active" : ""}${isSelected ? " is-selected" : ""}`}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => {
                  if (!option.disabled) dispatch({ type: "highlight", index });
                }}
                onClick={() => choose(index)}
              >
                <span className="ui-select-option-label">{option.label}</span>
                {isSelected ? <Check size={14} aria-hidden="true" /> : null}
              </li>
            );
          })}
        </ul>,
        portalTarget
      ) : null}
    </div>
  );
}
