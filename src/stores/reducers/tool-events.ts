import type { StreamEvent } from "@/shared/types";
import type { MessagePart } from "@/shared/types";
import type { StoreDraft } from "@/stores/store-helpers";

function isMessagePart(part: unknown): part is MessagePart {
  return !!part && typeof part === "object" && "type" in part;
}

export function applyToolEvent(state: StoreDraft, event: StreamEvent) {
  if (event.type === "tool.call") {
    const message = state.messages[event.messageId];
    if (message) message.parts = message.parts.filter(isMessagePart);
    if (message && !message.parts.some((part) => part.type === "tool_use" && part.callId === event.callId)) {
      message.parts.push({
        type: "tool_use",
        callId: event.callId,
        toolName: event.toolName,
        args: event.args
      });
    }
    return true;
  }

  if (event.type === "tool.result") {
    const message = state.messages[event.messageId];
    if (message) {
      message.parts = message.parts.filter(isMessagePart);
      const existing = message.parts.find(
        (part) => part.type === "tool_result" && part.callId === event.callId
      );
      if (existing?.type === "tool_result") {
        existing.result = event.result;
        existing.isError = event.isError;
      } else {
        message.parts.push({
          type: "tool_result",
          callId: event.callId,
          result: event.result,
          isError: event.isError
        });
      }
    }
    return true;
  }

  return false;
}
