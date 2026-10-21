import type { AdapterName, Agent, Conversation, Message, ReasoningEffort, Workspace } from "@/shared/types";
import type { ChatMessage } from "@/server/conversation-context";
import type { TaskExecutionContract, TaskExecutionIdentity } from "@/shared/evidence-types";
import type { HarnessEvent } from "./events";

export type { HarnessEvent } from "./events";

/**
 * The seam between the platform and an execution engine (issue #25).
 *
 * The invocation contract is deliberately *harness-neutral* (#25 P2). It carries
 * only what the platform owns and every harness needs: run identity, the context
 * the platform decided to send, the platform tool surface, a resolved
 * provider/model target, workspace root and ownership, budgets, access mode and
 * the platform's lifecycle callbacks. Pi's own vocabulary — its provider
 * snapshot, `contextXml`, the task-packet string, its access-profile type and its
 * durable lease object — stays inside the Pi driver.
 *
 * A second harness must satisfy this contract without the platform learning
 * about its internals; anything a driver cannot honestly support must be
 * reported here rather than emulated.
 */
export interface HarnessDriver {
  /** The legacy `AdapterName` value stored on Agent rows that selects this driver. */
  readonly id: AdapterName;

  /**
   * Whether this harness can run on this machine, with a human-readable reason
   * when it cannot. Must not throw for a missing/broken installation.
   */
  doctor(): HarnessDoctor;

  /** What this driver can truthfully do (#25 P1 capability matrix). */
  capabilities(): HarnessCapabilities;

  /**
   * Start exactly one invocation and return its lazily-consumed event stream.
   *
   * The driver owns translating this neutral input into whatever its engine
   * needs. A driver must not resolve credentials earlier than it needs them.
   */
  run(input: HarnessInvocationInput, signal: AbortSignal): HarnessRunStream;

  /**
   * Request cancellation of an in-flight run by platform run id, returning
   * whether this driver performed one.
   *
   * Pi has no run-id abort entry point: the only cancellation channel it
   * exposes is the AbortSignal handed to `run`, which the platform owns. The Pi
   * driver therefore reports `false` and advertises
   * `cancellation: { supported: true, mode: "signal" }`; this is not a bug to
   * paper over with an invented abort registry inside the driver.
   */
  abort(runId: string): boolean;
}

/** Small and honest: only what a caller needs to decide whether to dispatch. */
export interface HarnessDoctor {
  available: boolean;
  version?: string;
  detail?: string;
}

/**
 * The capability matrix (#25 P1).
 *
 * Every field answers a question the platform asks before it dispatches: can
 * this engine do the work an Agent's run needs, and can the platform still
 * verify it? A capability a driver cannot honestly provide is `false`, and the
 * run then fails through `assertHarnessSupports` before any work begins instead
 * of producing output nobody can verify. There is deliberately no field for a
 * capability the platform does not currently depend on.
 */
export interface HarnessCapabilities {
  /** The harness brings its own file and command tools (read/write/edit/bash/…). */
  nativeTools: boolean;

  /**
   * The harness can invoke the platform's business tools — `write_artifact`,
   * `deploy_*`, `report_task_result`, `ask_user` and the rest of the server-side
   * tool registry — not only its own native tools. Artifact delivery and
   * delegated task reporting both depend on this.
   */
  businessTools: boolean;

  /**
   * How a run can be cancelled. `"signal"`: the caller aborts the `AbortSignal`
   * it handed to `run`. `"run-id"`: `abort(runId)` also works. `mode` is `null`
   * when the harness cannot be cancelled at all.
   */
  cancellation: { supported: boolean; mode: "signal" | "run-id" | null };

  /**
   * Whether tool outcomes can be mapped into the platform evidence contract
   * (file hashes, command results, business-tool receipts). Without it a run may
   * still produce files, but delegated acceptance cannot be verified.
   */
  evidence: boolean;

  /**
   * `"platform"`: the harness consumes the context packet the platform compiles
   * (task identity, active facts, upstream artifacts, acceptance contract).
   * `"harness"`: it builds its own context, so that packet never reaches the model.
   */
  contextPacket: "platform" | "harness";

  /** Whether the harness accepts live steering/follow-ups mid-run. */
  followUp: boolean;

  /** Whether output is incremental (`HarnessEvent`s) rather than a final blob. */
  streaming: boolean;
}

/**
 * What one run needs from its harness before the platform may start it.
 *
 * Requirements are derived by the run owner from what that run is actually
 * provisioned with, never invented by a driver. A field that is absent or
 * `false` is not required: a classifier turn, for example, needs neither native
 * tools nor business tools.
 */
export interface HarnessRequirements {
  nativeTools?: boolean;
  businessTools?: boolean;
  evidence?: boolean;
  cancellation?: boolean;
  /** Only the platform-built packet is a requirement; a harness may otherwise build its own context. */
  contextPacket?: "platform";
}

/**
 * How much of the workspace this invocation may touch.
 *
 * `"conversation"` is a context-only phase: no workspace tools, no writes. It is
 * a platform decision, not a harness setting, and every harness must honour it.
 */
export type HarnessAccessMode = "workspace" | "conversation";

/**
 * The provider/model target the platform resolved before dispatch.
 *
 * This replaces Pi's provider snapshot: it names the provider, model, endpoint
 * and credential the platform selected, so a harness that uses a different
 * configuration file format still receives the same decision instead of
 * inheriting Pi's object shape. Drivers must treat `credential` as a secret and
 * must not persist it into their own configuration or logs.
 *
 * It also carries the Agent's model-shaping choices — thinking effort, image
 * input and the configured context window — because a second engine needs the
 * same decision, not a Pi-shaped config to translate.
 */
export interface HarnessProviderTarget {
  /** Provider id configured on the Agent (`deepseek`, `anthropic`, `profile:<id>`, …). */
  providerId: string;
  /** Provider family the platform derived model limits/catalog metadata from. */
  catalogProvider?: string;
  /** The model the platform selected, or `null` when the Agent is misconfigured. */
  modelId: string | null;
  /** Resolved HTTP(S) endpoint, or `null` when no endpoint could be resolved. */
  endpoint: string | null;
  /** Resolved credential value, or `null` when none is configured. */
  credential: string | null;
  /** Public configuration revision (never a credential), used for binding/audit. */
  revision: string;
  /**
   * The Agent's configured thinking effort, or `null` to leave thinking off.
   * The platform owns the choice; each driver maps it onto its own request shape.
   */
  reasoningEffort: ReasoningEffort | null;
  /** Whether the configured model accepts image input (`Agent.supportsVision`). */
  vision: boolean;
  /**
   * The Agent's configured context window, or `null` for the engine/model
   * default. Deliberately *not* resolved to a number here: the effective window
   * depends on the engine's own model catalog, so a driver resolves this against
   * it (Pi does so in `pi/config.ts`, which keeps its current numbers exactly).
   */
  contextWindow: number | null;
  /*
   * There is deliberately no `maxOutput`: the platform has no per-Agent output
   * cap. Pi derives it from its locked model catalog (falling back to the
   * provider's `outputReserve`), and inventing a platform field here would be a
   * number no Agent row owns.
   */
}

/** One attachment the platform authorized this invocation to reference. */
export interface HarnessContextAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  /** Workspace-relative path when the attachment lives inside the workspace. */
  workspacePath?: string;
}

/**
 * The platform-compiled context for one invocation.
 *
 * The platform decides *what* to send (authoritative task text, which prior
 * history is relevant, which attachments are in scope); a driver decides *how*
 * to serialize it. A delegated task gets no prior history, exactly as before.
 */
export interface HarnessContextPacket {
  /** Authoritative current-task text. */
  task: string;
  /** Prior platform context; always empty for delegated work. */
  priorHistory: ChatMessage[];
  /** Attachments belonging to this conversation/workspace. */
  attachments: HarnessContextAttachment[];
}

/** The context the platform decided to send, in neutral terms. */
export interface HarnessInvocationContext {
  /** System prompt compiled by the platform. */
  systemPrompt: string;
  /** The compiled task packet. */
  packet: HarnessContextPacket;
  /**
   * Recent conversation messages the platform made available. A harness that
   * compiles its own context (`contextPacket: "harness"`) can use them; a
   * platform-packet harness such as Pi does not need them.
   */
  recentMessages: Message[];
}

/**
 * The platform tool surface for one invocation.
 *
 * `names` are platform names (`fs_read`, `write_artifact`, …), not a particular
 * engine's native names; the driver maps them. `required` names the subset the
 * run cannot produce verifiable work without, so a driver cannot silently narrow
 * the surface the platform believes it granted.
 */
export interface HarnessToolProvisioning {
  names: string[];
  required: string[];
}

/**
 * A workspace-ownership handoff from a run that is blocked waiting on a peer.
 *
 * This is the platform's durable ownership concept, not Pi's lease class: the
 * platform owns the record and a driver supplies the implementation. Lending a
 * workspace while blocked is deliberately not part of this interface.
 */
export interface HarnessWorkspaceLease {
  readonly workspacePath: string;
  assertActive(): void;
  attachChild(pid: number): void;
  release(): void;
  poison(): void;
}

/** Audit receipt for the context the run actually sent. */
export interface HarnessContextReceipt {
  prompt: string;
  systemPromptHash: string;
  toolNames: string[];
  access: HarnessAccessMode;
}

/**
 * Everything the platform hands a harness for exactly one invocation.
 *
 * Fields are platform-owned. Nothing here names a Pi type or Pi-shaped payload:
 * the Pi driver converts this into `PiInvocationInput` (including rendering the
 * platform packet into Pi's prompt) and a second driver converts it into its own
 * invocation shape.
 */
export interface HarnessInvocationInput {
  // --- identity ---------------------------------------------------------
  conversationId: string;
  runId: string;
  parentRunId?: string | null;
  taskExecution?: TaskExecutionIdentity | null;
  taskContract?: TaskExecutionContract | null;
  /** The platform Agent that owns this run (identity and per-Agent settings). */
  agent: Agent;
  conversation: Conversation;
  workspace: Workspace;
  /** The platform message that triggered this run. */
  triggerMessage: Message;

  // --- context ----------------------------------------------------------
  context: HarnessInvocationContext;

  // --- tools / capabilities --------------------------------------------
  tools: HarnessToolProvisioning;
  requirements: HarnessRequirements;

  // --- provider / model -------------------------------------------------
  provider: HarnessProviderTarget;

  // --- workspace --------------------------------------------------------
  workspaceRoot: string;
  /** Present only when another run lent this invocation its workspace ownership. */
  workspaceLease?: HarnessWorkspaceLease;

  // --- budgets ----------------------------------------------------------
  maxTurns?: number;
  timeoutMs?: number;

  // --- access -----------------------------------------------------------
  /** Defaults to `"workspace"` when omitted. */
  access?: HarnessAccessMode;

  // --- platform callbacks ----------------------------------------------
  /** The harness confirmed the platform's task prompt entered its committed context. */
  onTaskAccepted?: () => void;
  onStage?: (stage: "queued" | "running") => void;
  onContextCaptured?: (receipt: HarnessContextReceipt) => void;
}

/**
 * The event stream a harness produces (#25 P2 output contract).
 *
 * It is the neutral `HarnessEvent` vocabulary, never the platform's persisted
 * `StreamEvent` wire shape: the driver reports output, tool activity, usage and
 * a terminal event, and `projectHarnessStream` turns that into today's
 * `part.*` / `tool.*` / `run.usage` shapes for `consumeStream`.
 */
export type HarnessRunStream = AsyncGenerator<HarnessEvent>;
