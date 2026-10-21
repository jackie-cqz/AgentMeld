"use client";

import { Cpu, RefreshCw, TriangleAlert } from "lucide-react";
import type { AdapterName } from "@/shared/types";
import { harnessOptionBadge, type HarnessEditorModel } from "@/lib/harness-selection";
import { Feedback } from "@/components/ui/controls";

/**
 * The engine picker in the Agent editor.
 *
 * Two different questions must stay visually distinct: every card here is
 * *selectable* (可选), while only a card the server reported as installed is
 * *runnable* (可用). All decisions live in `@/lib/harness-selection`; this is
 * markup only, so it can stay honest without a DOM test.
 */
export function HarnessPicker({ model, loading, error, onSelect, onRefresh }: {
  model: HarnessEditorModel;
  loading: boolean;
  error: string | null;
  onSelect: (value: AdapterName) => void;
  onRefresh: () => void;
}) {
  const selected = model.selected;
  // A failed read is not the same statement as "still checking".
  const statusLine = !selected?.checked && error
    ? "安装状态读取失败，暂时无法确认该引擎是否可用；这不影响保存。"
    : loading && !selected?.checked
      ? "正在检查执行引擎安装状态…"
      : model.statusText;
  return <div className="harness-picker">
    <div className="harness-picker-heading">
      <Cpu size={16} />
      <div>
        <h3>执行引擎</h3>
        <p>「可选」表示可以保存这个选择；只有标为「可用」的引擎，运行才会真正执行。</p>
      </div>
      <button type="button" className="ui-icon-button" title="重新检查执行引擎" aria-label="重新检查执行引擎" disabled={loading} onClick={onRefresh}>
        <RefreshCw size={14} />
      </button>
    </div>
    {error ? <Feedback>{error}</Feedback> : null}
    <div className="harness-picker-options" role="group" aria-label="执行引擎">
      {model.options.map((option) => <button
        key={option.value}
        type="button"
        className="harness-option"
        aria-pressed={option.value === selected?.value}
        aria-label={`执行引擎 ${option.label}：可选，${harnessOptionBadge(option)}`}
        onClick={() => onSelect(option.value)}
      >
        <span className="harness-option-name">
          <strong>{option.label}</strong>
          <small>{option.checked && option.doctor?.version ? `已安装版本 ${option.doctor.version}` : option.value}</small>
        </span>
        <span className="harness-chip">可选</span>
        <span className={`harness-badge is-${option.checked ? option.state : "checking"}`}>{harnessOptionBadge(option)}</span>
      </button>)}
    </div>
    <p className={`harness-status is-${selected?.checked ? selected.state : "checking"}`}>{statusLine}</p>
    {model.migrationNotice ? <div className="harness-migration" role="status"><TriangleAlert size={14} /><span>{model.migrationNotice}</span></div> : null}
  </div>;
}
