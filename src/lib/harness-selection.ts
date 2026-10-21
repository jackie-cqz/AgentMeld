import {
  HARNESS_DESCRIPTORS,
  harnessDescriptor,
  isSelectableAdapter,
  type HarnessAvailability,
  type HarnessDoctorReport,
  type HarnessState,
} from "@/shared/harness-catalog";
import type { AdapterName, Agent } from "@/shared/types";

/**
 * Pure view-model for the agent editor's harness picker.
 *
 * Kept out of the component so the node-only test suite can exercise the
 * decisions (which names are offered, what "selected" means, whether saving
 * warns) without a DOM. The runtime facts always come from the server payload;
 * nothing here upgrades a harness to runnable on its own.
 */
export interface HarnessOption {
  value: AdapterName;
  label: string;
  /** Runtime state when checked; the declared state while still loading. */
  state: HarnessState;
  /** Only a confirmed `available` report counts as runnable. */
  runnable: boolean;
  /** Whether a runtime report has arrived for this name yet. */
  checked: boolean;
  doctor: HarnessDoctorReport | null;
}

/**
 * Options offered in the editor: every catalog name marked selectable.
 *
 * Retired names never appear as a choice — they are migration targets, not
 * engines — so this list is exactly "Pi today, plus OpenCode once selected".
 */
export function harnessOptions(availability: readonly HarnessAvailability[] | null | undefined): HarnessOption[] {
  const byId = new Map((availability ?? []).map((entry) => [entry.id, entry]));
  return HARNESS_DESCRIPTORS.filter((descriptor) => descriptor.selectable).map((descriptor) => {
    const runtime = byId.get(descriptor.id) ?? null;
    const state = runtime?.state ?? descriptor.declaredState;
    return {
      value: descriptor.id,
      label: descriptor.label,
      state,
      runnable: runtime?.state === "available",
      checked: runtime !== null,
      doctor: runtime?.doctor ?? null,
    };
  });
}

export function selectedHarnessOption(options: readonly HarnessOption[], id: AdapterName): HarnessOption | null {
  return options.find((option) => option.value === id) ?? null;
}

/**
 * Short badge for an option card. "可选" is the editor's job — every offered
 * option is selectable — so this word answers the other question: can it run?
 */
export function harnessOptionBadge(option: HarnessOption): string {
  if (!option.checked) return "检查中";
  if (option.state === "available") return "可用";
  if (option.state === "retired") return "已退役";
  return "不可运行";
}

/**
 * One honest sentence about the selected harness, in the UI's language.
 *
 * A not-installed harness says exactly what will happen if it is saved: the row
 * keeps the choice and the run fails as `harness_unavailable`; it is not
 * silently replaced by Pi. Nothing here claims a selection will work.
 */
export function harnessStatusText(option: HarnessOption): string {
  if (!option.checked) return "正在检查执行引擎安装状态…";
  if (option.state === "available") {
    // "Available" is an installation fact, not a promise that every run works:
    // the dispatch gate still checks the capabilities a task requires (an
    // OpenCode run, for example, is refused when it needs business tools).
    return option.doctor?.version
      ? `已安装 ${option.doctor.version}；运行时会按任务所需能力校验。`
      : "已安装；运行时会按任务所需能力校验。";
  }
  if (option.state === "retired") {
    return "该执行引擎已退役，不能作为新选择。";
  }
  if (option.doctor) {
    // The driver exists in this build but its own probe failed (for example,
    // the platform CLI is not installed). Name the real reason instead of
    // pretending the driver is missing.
    return `${option.label} 的驱动已包含在当前构建中，但引擎当前不可运行：${option.doctor.detail ?? "安装检查未通过"}。可以保存；运行会失败，不会自动改用 Pi。`;
  }
  return `${option.label} 驱动未包含在当前构建中：可以保存，但运行时会以 harness_unavailable（执行引擎不可用）失败，不会自动改用 Pi。`;
}

/** Suffix for the save button so the failure mode is visible before the click. */
export function harnessSaveSuffix(option: HarnessOption | null): string {
  if (!option?.checked || option.state === "available") return "";
  return option.state === "retired" ? "（将迁移到 Pi）" : "（不可运行）";
}

/** Whether the editor may save this selection as-is. Retired names may not be chosen. */
export function harnessSelectionIsAllowed(option: HarnessOption | null): boolean {
  return option !== null && option.state !== "retired";
}

/**
 * Label for rosters and lists: a name this build cannot run says so.
 *
 * The declared state is the right source here, not a live probe. A selectable
 * name such as OpenCode ships a driver, so its runtime availability (doctor) is
 * deliberately not asserted by this cached label; a non-selectable unknown name
 * has no driver in this build and keeps the warning.
 */
export function harnessDisplayLabel(name: AdapterName | string): string {
  const descriptor = harnessDescriptor(name);
  if (descriptor.declaredState === "retired") return `${descriptor.label}（已退役）`;
  if (descriptor.declaredState === "not-installed" && !descriptor.selectable) return `${descriptor.label}（不可运行）`;
  return descriptor.label;
}

/**
 * What the editor must say about the engine already stored on an Agent row.
 *
 * A retired (or otherwise non-selectable) stored engine is never offered as a
 * choice, so the only honest thing to say is that saving migrates the row to Pi.
 * Returns `null` when the stored engine is a current choice.
 */
export function harnessMigrationNotice(stored: AdapterName | string | null | undefined): string | null {
  if (!stored || isSelectableAdapter(stored)) return null;
  const descriptor = harnessDescriptor(stored);
  const reason = descriptor.declaredState === "retired" ? "已退役" : "不在当前构建中";
  return `原执行引擎 ${descriptor.label} ${reason}：保存后此 Agent 将改用 Pi 运行，身份与历史不变。`;
}

/**
 * Whether the server's availability report says this engine can run here.
 *
 * Only a confirmed `available` row counts. A missing row (still loading, or a
 * failed read) is not evidence that the engine runs, so callers must not offer
 * an action on it.
 */
export function harnessIsRunnable(
  availability: readonly HarnessAvailability[] | null | undefined,
  name: AdapterName | string,
): boolean {
  return (availability ?? []).some((entry) => entry.id === name && entry.state === "available");
}

/**
 * Team members a task can be handed off to: current non-Conductor members whose
 * engine the platform reports as available, in roster order.
 *
 * Derived from the catalog/availability instead of a stored adapter literal so a
 * second registered engine becomes a real handoff target, while an engine this
 * build cannot run is never offered.
 */
export function handoffTargets(input: {
  agentIds: readonly string[];
  agents: Readonly<Record<string, Agent>>;
  sourceAgentId: string;
  availability: readonly HarnessAvailability[] | null | undefined;
}): Agent[] {
  return input.agentIds
    .map((id) => input.agents[id])
    .filter((agent): agent is Agent => Boolean(agent))
    .filter((agent) =>
      !agent.isConductor &&
      agent.id !== input.sourceAgentId &&
      harnessIsRunnable(input.availability, agent.adapterName),
    );
}

/** Everything the picker and the dialog's save button need, derived once. */
export interface HarnessEditorModel {
  options: HarnessOption[];
  selected: HarnessOption | null;
  /** One sentence about the current selection. */
  statusText: string;
  /** Migration guidance for a stored engine that is no longer a choice. */
  migrationNotice: string | null;
  /** Whether the current selection may be saved. */
  canSave: boolean;
  /** Suffix for the save button. */
  saveSuffix: string;
}

export function harnessEditorModel(input: {
  availability: readonly HarnessAvailability[] | null | undefined;
  selected: AdapterName;
  /** The engine stored on the Agent being edited; `null` when creating. */
  stored?: AdapterName | string | null;
}): HarnessEditorModel {
  const options = harnessOptions(input.availability);
  const selected = selectedHarnessOption(options, input.selected);
  return {
    options,
    selected,
    statusText: selected ? harnessStatusText(selected) : "",
    migrationNotice: harnessMigrationNotice(input.stored),
    canSave: harnessSelectionIsAllowed(selected),
    saveSuffix: harnessSaveSuffix(selected),
  };
}
