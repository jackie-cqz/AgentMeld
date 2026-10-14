"use client";

import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

const subscribe = () => () => {};

export function Popover({ x, y, children, onClose, label, className = "" }: { x: number; y: number; children: ReactNode; onClose: () => void; label: string; className?: string }) {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    const surface = ref.current;
    if (!mounted || !surface) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let disposing = false;
    surface.showPopover();
    const bounds = surface.getBoundingClientRect();
    surface.style.left = `${Math.max(12, Math.min(x, window.innerWidth - bounds.width - 12))}px`;
    surface.style.top = `${Math.max(12, Math.min(y, window.innerHeight - bounds.height - 12))}px`;
    surface.querySelector<HTMLElement>('button:not(:disabled), input, a[href]')?.focus({ preventScroll: true });
    const close = () => closeRef.current();
    const toggle = (event: Event) => {
      if ((event as ToggleEvent).newState === "closed" && !disposing) { close(); trigger?.focus({ preventScroll: true }); }
    };
    surface.addEventListener("toggle", toggle);
    window.addEventListener("resize", close);
    return () => { disposing = true; surface.removeEventListener("toggle", toggle); window.removeEventListener("resize", close); surface.hidePopover(); };
  }, [mounted, x, y]);
  return mounted ? createPortal(<div ref={ref} popover="auto" className={`ui-popover ${className}`} role="dialog" aria-label={label}>{children}</div>, document.body) : null;
}
