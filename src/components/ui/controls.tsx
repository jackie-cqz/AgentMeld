"use client";

import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { useId, type ReactNode } from "react";

export function Feedback({ children, tone = "error" }: { children: ReactNode; tone?: "error" | "success" | "info" }) {
  const Icon = tone === "error" ? AlertCircle : tone === "success" ? CheckCircle2 : Info;
  return <div className={`ui-feedback ui-feedback--${tone}`} role={tone === "error" ? "alert" : "status"}><Icon size={16} /><span>{children}</span></div>;
}

export function Tabs<T extends string>({ value, onChange, items, label }: {
  value: T; onChange: (value: T) => void; items: { value: T; label: string; shortLabel?: string; icon?: ReactNode; disabled?: boolean }[]; label: string;
}) {
  const id = useId();
  return <div className="ui-tabs" role="tablist" aria-label={label} onKeyDown={event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const available = items.filter(item => !item.disabled);
    const index = available.findIndex(item => item.value === value);
    const next = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length;
    if (available[next]) {
      onChange(available[next].value);
      document.getElementById(`${id}-${available[next].value}`)?.focus();
    }
  }}>{items.map(item => <button type="button" role="tab" id={`${id}-${item.value}`} key={item.value} aria-selected={value === item.value} tabIndex={value === item.value ? 0 : -1}
    disabled={item.disabled} onClick={() => onChange(item.value)}>{item.icon}{item.shortLabel ? <><span className="ui-tab-full-label">{item.label}</span><span className="ui-tab-short-label">{item.shortLabel}</span></> : item.label}</button>)}</div>;
}

export function SectionHeading({ title, detail }: { title: string; detail?: string }) {
  return <div className="ui-section-heading"><h3>{title}</h3>{detail ? <p>{detail}</p> : null}</div>;
}
