"use client";

import { X } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

const subscribe = () => () => {};
let modalCount = 0;
let previousOverflow = "";

export function Modal({ open, onClose, title, description, children, footer, navigation, size = "medium", busy = false, className = "" }: {
  open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode;
  footer?: ReactNode; navigation?: ReactNode; size?: "small" | "medium" | "wide" | "drawer"; busy?: boolean; className?: string;
}) {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!mounted || !open || !dialog) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (modalCount++ === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      dialog.close();
      if (--modalCount === 0) document.body.style.overflow = previousOverflow;
      queueMicrotask(() => {
        if (trigger?.isConnected && (!trigger.closest("dialog") || trigger.closest("dialog")?.open)) {
          trigger.focus({ preventScroll: true });
        }
      });
    };
  }, [mounted, open]);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!mounted || !open || busy || !dialog?.open || dialog.contains(document.activeElement)) return;
    // Disabling a focused save button can move focus to <body>. Restore it after a failed save.
    const dialogs = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
    if (dialogs[dialogs.length - 1] === dialog) dialog.querySelector<HTMLElement>("[data-autofocus], button:not(:disabled)")?.focus();
  }, [mounted, open, busy]);

  if (!mounted || !open) return null;
  return createPortal(
    <dialog ref={ref} aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} aria-busy={busy}
      className={`ui-modal ui-modal--${size} ${className}`}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'
        )).filter(node => node.getClientRects().length > 0 && node.tabIndex >= 0 && !node.closest("[inert]"));
        const first = controls[0];
        const last = controls.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }}
      onClick={event => {
        if (event.target !== event.currentTarget || busy) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}>
      <header className="ui-modal-header">
        <div className="min-w-0"><h2 id={titleId}>{title}</h2>{description ? <p id={descriptionId}>{description}</p> : null}</div>
        <button type="button" className="ui-icon-button" aria-label={`关闭${title}`} title="关闭" onClick={onClose} disabled={busy}><X size={18} /></button>
      </header>
      {navigation ? <div className="ui-modal-nav">{navigation}</div> : null}
      <div className="ui-modal-body ui-form" data-ui-scroll inert={busy}>{children}</div>
      {footer ? <footer className="ui-modal-footer">{footer}</footer> : null}
    </dialog>, document.body
  );
}

export function useUnsavedChanges(dirty: boolean, close: () => void, busy = false) {
  const [confirming, setConfirming] = useState(false);
  const requestClose = () => { if (!busy) { if (dirty) setConfirming(true); else close(); } };
  const confirmation = <Modal open={confirming} onClose={() => setConfirming(false)} title="放弃未保存的修改？" size="small"
    footer={<><button className="ui-button" onClick={() => setConfirming(false)}>继续编辑</button><button className="ui-button ui-button--danger" onClick={() => { setConfirming(false); close(); }}>放弃修改</button></>}>
    <p className="ui-muted">关闭后，本次未保存的内容将不会保留。</p>
  </Modal>;
  return { requestClose, confirmation };
}
