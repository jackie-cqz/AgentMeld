import { nanoid } from "nanoid";

const ID_SIZE = 12;

export function newAgentId() {
  return `ag_${nanoid(ID_SIZE)}`;
}

export function newConversationId() {
  return `conv_${nanoid(ID_SIZE)}`;
}

export function newMessageId() {
  return `msg_${nanoid(ID_SIZE)}`;
}

export function newErrorMessageId() {
  return `msg_err_${nanoid(ID_SIZE)}`;
}

export function newRunId() {
  return `run_${nanoid(ID_SIZE)}`;
}

export function newArtifactId() {
  return `art_${nanoid(ID_SIZE)}`;
}

export function newWorkspaceId() {
  return `ws_${nanoid(ID_SIZE)}`;
}

export function newAttachmentId() {
  return `att_${nanoid(ID_SIZE)}`;
}

export function newContextSummaryId() {
  return `ctx_${nanoid(ID_SIZE)}`;
}

export function newToolCallId() {
  return `call_${nanoid(ID_SIZE)}`;
}
