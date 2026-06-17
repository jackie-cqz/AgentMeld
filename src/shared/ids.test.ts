import { describe, expect, it } from "vitest";
import {
  newAgentId,
  newArtifactId,
  newAttachmentId,
  newContextSummaryId,
  newConversationId,
  newErrorMessageId,
  newMessageId,
  newRunId,
  newToolCallId,
  newWorkspaceId
} from "@/shared/ids";

describe("id helpers", () => {
  it("generates stable entity prefixes with 12 character payloads", () => {
    expect(newAgentId()).toMatch(/^ag_[A-Za-z0-9_-]{12}$/);
    expect(newConversationId()).toMatch(/^conv_[A-Za-z0-9_-]{12}$/);
    expect(newMessageId()).toMatch(/^msg_[A-Za-z0-9_-]{12}$/);
    expect(newErrorMessageId()).toMatch(/^msg_err_[A-Za-z0-9_-]{12}$/);
    expect(newArtifactId()).toMatch(/^art_[A-Za-z0-9_-]{12}$/);
    expect(newWorkspaceId()).toMatch(/^ws_[A-Za-z0-9_-]{12}$/);
    expect(newAttachmentId()).toMatch(/^att_[A-Za-z0-9_-]{12}$/);
    expect(newRunId()).toMatch(/^run_[A-Za-z0-9_-]{12}$/);
    expect(newContextSummaryId()).toMatch(/^ctx_[A-Za-z0-9_-]{12}$/);
    expect(newToolCallId()).toMatch(/^call_[A-Za-z0-9_-]{12}$/);
  });
});
