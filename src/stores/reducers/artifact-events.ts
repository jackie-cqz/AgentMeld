import type { MessagePart, StreamEvent } from "@/shared/types";
import { type StoreDraft, upsertArtifact } from "@/stores/store-helpers";

export function applyArtifactEvent(state: StoreDraft, event: StreamEvent) {
  if (event.type === "artifact.create") {
    upsertArtifact(state, event.artifact);
    return true;
  }

  if (event.type === "artifact.update") {
    const artifact = state.artifacts[event.artifactId];
    if (artifact) {
      artifact.content = { ...artifact.content, ...event.patch } as typeof artifact.content;
      artifact.updatedAt = event.timestamp;
    }
    return true;
  }

  if (event.type === "deploy.status") {
    const message = state.messages[event.messageId];
    if (message) {
      const existingIndex = message.parts.findIndex(
        (part) => part.type === "deploy_status" && part.deployment.id === event.deployment.id
      );
      const part: MessagePart = { type: "deploy_status", deployment: event.deployment };
      if (existingIndex >= 0) message.parts[existingIndex] = part;
      else message.parts.push(part);
    }
    return true;
  }

  return false;
}
