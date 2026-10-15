import { nanoid } from "nanoid";

const ID_SIZE = 12;

export function newModelProviderId() {
  return `mp_${nanoid(ID_SIZE)}`;
}

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

export function newTaskAttemptId() {
  return `ta_${nanoid(ID_SIZE)}`;
}

export function newContextSnapshotId() {
  return `ctxsnap_${nanoid(ID_SIZE)}`;
}

export function newEvidenceId() {
  return `ev_${nanoid(ID_SIZE)}`;
}

export function newVerdictId() {
  return `vd_${nanoid(ID_SIZE)}`;
}

export function newFactId() {
  return `fact_${nanoid(ID_SIZE)}`;
}

export function newChannelBindingId() {
  return `cb_${nanoid(ID_SIZE)}`;
}

export function newChannelBindingSessionId() {
  return `cbs_${nanoid(ID_SIZE)}`;
}

export function newChannelConversationId() {
  return `cc_${nanoid(ID_SIZE)}`;
}

export function newChannelInboundMessageId() {
  return `cim_${nanoid(ID_SIZE)}`;
}
