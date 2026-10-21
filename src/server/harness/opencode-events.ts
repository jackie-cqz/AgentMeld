import type {
  ApiError,
  AssistantMessage,
  Event,
  MessageAbortedError,
  MessageOutputLengthError,
  Part,
  ProviderAuthError,
  UnknownError,
} from "@opencode-ai/sdk/client";
import type { UsagePayload } from "@/shared/types";
import { harnessErrorFromCategory, HarnessError } from "./errors";
import type { HarnessEvent, HarnessOutputKind } from "./events";

/**
 * OpenCode's own failures, mapped onto the neutral harness taxonomy.
 *
 * Every member of this union is one the SDK's generated types declare on
 * `session.error` / `AssistantMessage.error`; there is no invented shape. Any
 * name this build does not know takes the documented `runtime` fallback, exactly
 * like the Pi driver.
 */
export type OpenCodeFailure =
  | ProviderAuthError
  | UnknownError
  | MessageOutputLengthError
  | MessageAbortedError
  | ApiError;

/** The terminal facts a projection can report to its run owner. */
export interface OpenCodeProjectionState {
  /** `session.idle` (or an equivalent idle status) was observed for this session. */
  idle: boolean;
  /** The engine committed at least one assistant message. */
  sawAssistantMessage: boolean;
  /** The platform prompt was seen committed as a user message. */
  taskAccepted: boolean;
  /** The last `session.error` / assistant error, if any. */
  failure: OpenCodeFailure | null;
  /** Aggregated provider usage, or `null` when the engine reported none. */
  usage: UsagePayload | null;
}

/**
 * Map OpenCode's SSE event stream onto the neutral `HarnessEvent` vocabulary.
 *
 * The mapper is a pure state machine so it can be tested from a scripted event
 * array without an OpenCode process. It owns four facts the neutral stream needs
 * but OpenCode reports differently:
 *
 * 1. **Role filtering.** OpenCode echoes the platform prompt back as a user
 *    message and streams parts for it. The platform already owns that text, so
 *    only assistant-message parts become output. When a part arrives before its
 *    `message.updated` role, it is buffered and replayed once the role is known.
 * 2. **Snapshot → delta.** OpenCode usually updates a text/reasoning part with a
 *    growing snapshot (`part.text`) and omits `properties.delta`. The mapper
 *    derives the appended suffix from the previous snapshot, so the platform
 *    still receives incremental `output.delta` events.
 * 3. **Part lifecycle.** A `tool` part is re-emitted as it moves
 *    pending → running → completed/error; the mapper emits exactly one
 *    `tool.call` and one `tool.result` per call id.
 * 4. **Usage.** Assistant messages carry token counts and are re-emitted with
 *    growing `time.completed`; the mapper keeps the latest count per message id
 *    and sums across messages instead of double-counting updates.
 */
export class OpenCodeEventProjection {
  private readonly roles = new Map<string, "user" | "assistant">();
  private readonly pending = new Map<string, Array<{ part: Part; delta?: string }>>();
  private readonly textBlocks = new Map<string, TextBlock>();
  private readonly openBlocks = new Set<string>();
  private readonly endedBlocks = new Set<string>();
  private readonly toolEvents = new Map<string, { called: boolean; resulted: boolean }>();
  private readonly assistantUsage = new Map<string, AssistantUsage>();
  private readonly sessionId: string;
  private readonly expectedUserPrompt: string | undefined;
  private nextBlockIndex = 0;
  private idle = false;
  private taskAccepted = false;
  private failure: OpenCodeFailure | null = null;
  private sawAssistantMessage = false;

  constructor(options: { sessionId: string; expectedUserPrompt?: string }) {
    this.sessionId = options.sessionId;
    this.expectedUserPrompt = options.expectedUserPrompt;
  }

  /** Consume one SDK event and return the neutral events it implies. */
  observe(event: Event): HarnessEvent[] {
    switch (event.type) {
      case "message.updated":
        return this.onMessageUpdated(event.properties.info);

      case "message.part.updated":
        return this.onPartUpdated(event.properties.part, event.properties.delta);

      case "message.part.removed": {
        // A removed part must not leave an open block behind.
        if (event.properties.sessionID !== this.sessionId) return [];
        return this.closeBlock(event.properties.partID);
      }

      case "session.idle": {
        if (event.properties.sessionID !== this.sessionId) return [];
        this.idle = true;
        return this.closeAllBlocks();
      }

      case "session.status": {
        if (event.properties.sessionID !== this.sessionId) return [];
        if (event.properties.status.type === "idle") {
          this.idle = true;
          return this.closeAllBlocks();
        }
        return [];
      }

      case "session.error": {
        const error = event.properties.error;
        // A server may host several sessions; only this invocation's error is
        // this run's failure.
        if (event.properties.sessionID && event.properties.sessionID !== this.sessionId) return [];
        if (error) this.recordFailure(error);
        return [];
      }

      default:
        // Every other OpenCode event (file watchers, LSP, pty, todos, …) is not
        // assistant output or tool activity and is deliberately not projected.
        return [];
    }
  }

  /** Terminal facts for the run owner; safe to call after every event. */
  state(): OpenCodeProjectionState {
    return {
      idle: this.idle,
      sawAssistantMessage: this.sawAssistantMessage,
      taskAccepted: this.taskAccepted,
      failure: this.failure,
      usage: this.usage(),
    };
  }

  /** Close every open block, e.g. when the run is aborted mid-stream. */
  closeAllBlocks(): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    for (const partId of [...this.openBlocks]) events.push(...this.closeBlock(partId));
    return events;
  }

  private onMessageUpdated(info: AssistantMessage | { role: "user"; id: string; sessionID: string }): HarnessEvent[] {
    if (info.sessionID !== this.sessionId) return [];
    if (info.role === "user") {
      this.roles.set(info.id, "user");
      return this.flushPending(info.id);
    }

    this.roles.set(info.id, "assistant");
    this.sawAssistantMessage = true;
    const assistant = info as AssistantMessage;
    this.assistantUsage.set(assistant.id, {
      modelId: assistant.modelID,
      input: finite(assistant.tokens?.input),
      output: finite(assistant.tokens?.output) + finite(assistant.tokens?.reasoning),
      cacheRead: finite(assistant.tokens?.cache?.read),
      cacheCreate: finite(assistant.tokens?.cache?.write),
    });
    if (assistant.error) this.recordFailure(assistant.error);

    const events = this.flushPending(assistant.id);
    // A completed assistant message cannot still be streaming text.
    if (assistant.time?.completed !== undefined) {
      for (const [partId, block] of this.textBlocks) {
        if (block.messageID === assistant.id) events.push(...this.closeBlock(partId));
      }
    }
    return events;
  }

  private onPartUpdated(part: Part, delta: string | undefined): HarnessEvent[] {
    if (part.sessionID !== this.sessionId) return [];
    const role = this.roles.get(part.messageID);
    if (role === undefined) {
      // Role events and part events race; buffer until the user/assistant
      // decision is known rather than leaking the platform's own prompt back.
      const queued = this.pending.get(part.messageID) ?? [];
      queued.push({ part, delta });
      this.pending.set(part.messageID, queued);
      return [];
    }
    if (role === "user") {
      this.acceptUserPart(part);
      return [];
    }
    return this.projectPart(part, delta);
  }

  private flushPending(messageID: string): HarnessEvent[] {
    const queued = this.pending.get(messageID);
    if (!queued) return [];
    this.pending.delete(messageID);
    const role = this.roles.get(messageID);
    if (role === "user") {
      for (const entry of queued) this.acceptUserPart(entry.part);
      return [];
    }
    const events: HarnessEvent[] = [];
    for (const entry of queued) events.push(...this.projectPart(entry.part, entry.delta));
    return events;
  }

  private acceptUserPart(part: Part): void {
    if (this.taskAccepted || this.expectedUserPrompt === undefined) return;
    if (part.type !== "text" || part.synthetic === true || part.ignored === true) return;
    if (part.text === this.expectedUserPrompt) this.taskAccepted = true;
  }

  private projectPart(part: Part, delta: string | undefined): HarnessEvent[] {
    switch (part.type) {
      case "text":
      case "reasoning":
        return this.projectText(part, delta);
      case "tool":
        return this.projectTool(part);
      default:
        // step-start/step-finish/snapshot/patch/file/agent/retry/compaction/subtask
        return [];
    }
  }

  private projectText(part: Extract<Part, { type: "text" | "reasoning" }>, delta: string | undefined): HarnessEvent[] {
    if (part.type === "text" && (part.synthetic === true || part.ignored === true)) return [];
    // Once a block has ended, a late snapshot must not open a second block for
    // the same part id (the platform already closed that part slot).
    if (this.endedBlocks.has(part.id)) return [];
    const kind: HarnessOutputKind = part.type === "text" ? "text" : "thinking";
    const snapshot = part.text ?? "";
    const existing = this.textBlocks.get(part.id);
    const events: HarnessEvent[] = [];

    if (!existing) {
      // Do not open a block for an empty snapshot with no delta: the first
      // meaningful update opens it, which keeps empty parts out of the message.
      if (!snapshot && !delta) return [];
      const block: TextBlock = {
        blockIndex: this.nextBlockIndex++,
        kind,
        partId: part.id,
        messageID: part.messageID,
        text: "",
      };
      this.textBlocks.set(part.id, block);
      this.openBlocks.add(part.id);
      events.push({ type: "output.start", blockIndex: block.blockIndex, kind, content: "" });
      const initial = delta ?? snapshot;
      if (initial) {
        block.text += initial;
        events.push({ type: "output.delta", blockIndex: block.blockIndex, kind, text: initial });
      }
      if (part.time?.end !== undefined) events.push(...this.closeBlock(part.id));
      return events;
    }

    if (delta !== undefined) {
      if (delta) {
        existing.text += delta;
        events.push({ type: "output.delta", blockIndex: existing.blockIndex, kind, text: delta });
      }
    } else if (snapshot.startsWith(existing.text) && snapshot.length > existing.text.length) {
      const appended = snapshot.slice(existing.text.length);
      existing.text = snapshot;
      events.push({ type: "output.delta", blockIndex: existing.blockIndex, kind, text: appended });
    }
    // A snapshot that is shorter or not a prefix of what was streamed is an
    // out-of-order/rewritten part. Appending it would corrupt the block, so it
    // is ignored rather than guessed at.

    if (part.time?.end !== undefined) events.push(...this.closeBlock(part.id));
    return events;
  }

  private projectTool(part: Extract<Part, { type: "tool" }>): HarnessEvent[] {
    const state = part.state;
    const callId = part.callID || part.id;
    const events: HarnessEvent[] = [];
    let emitted = this.toolEvents.get(callId);
    if (!emitted) {
      emitted = { called: false, resulted: false };
      this.toolEvents.set(callId, emitted);
    }

    if (!emitted.called && state.status !== "pending") {
      // A `pending` tool part has not parsed arguments yet (OpenCode reports
      // `{}` until the call starts). Waiting for running/completed/error is what
      // makes the neutral `tool.call` carry the arguments the engine is using.
      emitted.called = true;
      events.push({ type: "tool.call", callId, toolName: part.tool, args: state.input });
    }

    if (!emitted.resulted && (state.status === "completed" || state.status === "error")) {
      emitted.resulted = true;
      events.push(state.status === "completed"
        ? {
            type: "tool.result",
            callId,
            result: { output: state.output, title: state.title, metadata: state.metadata },
            isError: false,
          }
        : {
            type: "tool.result",
            callId,
            result: { error: state.error, metadata: state.metadata },
            isError: true,
          });
    }
    return events;
  }

  private closeBlock(partId: string): HarnessEvent[] {
    const block = this.textBlocks.get(partId);
    if (!block || !this.openBlocks.has(partId)) return [];
    this.openBlocks.delete(partId);
    this.endedBlocks.add(partId);
    return [{ type: "output.end", blockIndex: block.blockIndex }];
  }

  private recordFailure(failure: OpenCodeFailure): void {
    // Keep the first failure: it is the cause; later events are consequences.
    this.failure ??= failure;
  }

  private usage(): UsagePayload | null {
    if (this.assistantUsage.size === 0) return null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let modelId: string | undefined;
    for (const entry of this.assistantUsage.values()) {
      inputTokens += entry.input;
      outputTokens += entry.output;
      cacheReadTokens += entry.cacheRead;
      cacheCreationTokens += entry.cacheCreate;
      modelId ??= entry.modelId;
    }
    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0) return null;
    return {
      ...(modelId ? { modelId } : {}),
      inputTokens,
      outputTokens,
      ...(cacheReadTokens ? { cacheReadTokens } : {}),
      ...(cacheCreationTokens ? { cacheCreationTokens } : {}),
    };
  }
}

interface TextBlock {
  blockIndex: number;
  kind: HarnessOutputKind;
  partId: string;
  messageID: string;
  text: string;
}

interface AssistantUsage {
  modelId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Translate an OpenCode failure into the neutral error taxonomy exactly once.
 *
 * The known names are the ones the SDK declares; status-bearing `APIError`s are
 * split by the status codes the platform already distinguishes, and anything
 * else is an ordinary failed provider request. An unfamiliar name still becomes
 * a `HarnessError` through the documented `runtime` fallback (with the raw name
 * preserved on `sourceCategory`), never a leaked SDK exception.
 */
export function toHarnessError(failure: OpenCodeFailure): HarnessError {
  switch (failure.name) {
    case "ProviderAuthError":
      return new HarnessError(failure.data.message || "OpenCode could not authenticate the configured provider.", "authentication");
    case "MessageAbortedError":
      return new HarnessError(failure.data.message || "The OpenCode run was aborted.", "aborted");
    case "MessageOutputLengthError":
      return new HarnessError("OpenCode exhausted the model output budget.", "output_limit");
    case "APIError": {
      const message = failure.data.message || "The OpenCode provider request failed.";
      const status = failure.data.statusCode;
      if (status === 401 || status === 403) return new HarnessError(message, "authentication");
      if (status === 429) return new HarnessError(message, "rate_limit");
      if (status === 408 || status === 504) return new HarnessError(message, "timeout");
      return new HarnessError(message, "provider");
    }
    case "UnknownError":
      return new HarnessError(failure.data.message || "OpenCode reported an unknown error.", "runtime");
    default:
      return harnessErrorFromCategory("OpenCode reported an engine error.", (failure as { name?: string }).name ?? "runtime");
  }
}
