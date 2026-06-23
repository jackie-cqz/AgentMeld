"use client";

import { ArrowUp, AtSign, File, Loader2, Paperclip, ShieldCheck, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { requestJson } from "@/lib/request-json";
import { useAppStore } from "@/stores/app-store";
import { selectConversationPendingDispatchPlans } from "@/stores/selectors";
import type { Agent, Attachment, Conversation } from "@/shared/types";

const EMPTY_ATTACHMENTS: Attachment[] = [];
const RIGHT_PANEL_GAP = 32;

interface MessageInputProps {
  conversationId: string;
  agents: Agent[];
  rightPanelOpen?: boolean;
  rightPanelWidth?: number;
}

export function MessageInput({
  conversationId,
  agents,
  rightPanelOpen = false,
  rightPanelWidth = 0
}: MessageInputProps) {
  const draft = useAppStore((state) => state.composerDraftByConversation[conversationId] ?? "");
  const setDraft = useAppStore((state) => state.setComposerDraft);
  const sendMessage = useAppStore((state) => state.sendMessage);
  const replyTargetId = useAppStore((state) => state.replyTargetByConversation[conversationId] ?? null);
  const replyTarget = useAppStore((state) => replyTargetId ? state.messages[replyTargetId] ?? null : null);
  const setReplyTarget = useAppStore((state) => state.setReplyTarget);
  const attachments = useAppStore((state) => state.pendingAttachmentsByConversation[conversationId] ?? EMPTY_ATTACHMENTS);
  const addPendingAttachment = useAppStore((state) => state.addPendingAttachment);
  const removePendingAttachment = useAppStore((state) => state.removePendingAttachment);
  const approvalMode = useAppStore((state) => state.conversations[conversationId]?.fsWriteApprovalMode ?? "auto");
  const updateConversation = useAppStore((state) => state.updateConversation);
  const pendingDispatchPlans = useAppStore(
    useShallow((state) => selectConversationPendingDispatchPlans(state, conversationId))
  );
  const [mentionedAgentIds, setMentionedAgentIds] = useState<string[]>([]);
  const [reviseForPlanId, setReviseForPlanId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mentionedAgents = useMemo(
    () => agents.filter((agent) => mentionedAgentIds.includes(agent.id)),
    [agents, mentionedAgentIds]
  );

  // Check if there's a pending plan for this conversation → revise mode
  const pendingPlan = pendingDispatchPlans[0] ?? null;

  const isReviseMode = reviseForPlanId !== null && pendingPlan?.id === reviseForPlanId;

  const submit = async () => {
    if (!draft.trim() || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      if (isReviseMode && pendingPlan) {
        await requestJson(`/api/dispatch-plans/${pendingPlan.id}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "revise",
            feedback: draft.trim()
          })
        });
        setDraft(conversationId, "");
        setReviseForPlanId(null);
        return;
      }

      await sendMessage(conversationId, draft.trim(), {
        mentionedAgentIds,
        attachmentIds: attachments.map((attachment) => attachment.id),
        parentMessageId: replyTargetId
      });
      setMentionedAgentIds([]);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "发送失败。");
    } finally {
      setSubmitting(false);
    }
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.set("file", file);
        formData.set("conversationId", conversationId);
        const data = await requestJson<{ attachment: Attachment }>("/api/attachments", {
          method: "POST",
          body: formData
        });
        addPendingAttachment(conversationId, data.attachment);
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "附件上传失败。");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const toggleMention = (agentId: string) => {
    setMentionedAgentIds((current) =>
      current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId]
    );
  };
  const inputStyle = rightPanelOpen ? { marginRight: rightPanelWidth + RIGHT_PANEL_GAP } : undefined;

  return (
    <footer className="shrink-0 border-t border-slate-200 bg-white px-4 py-4">
      <div className="rounded-xl border border-slate-200 bg-white p-2 shadow-[0_10px_34px_rgba(15,23,42,0.08)]" style={inputStyle}>
        <div className="mb-2 flex flex-wrap gap-2 px-2 pt-1">
          {agents.map((agent) => (
            <button
              key={agent.id}
              className={`flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition ${
                mentionedAgentIds.includes(agent.id)
                  ? "border-[#4264ff] bg-[#eff5ff] text-[#2546d8]"
                  : "border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 hover:bg-white"
              }`}
              type="button"
              onClick={() => toggleMention(agent.id)}
              title={`@${agent.name}`}
            >
              <AtSign className="h-3.5 w-3.5" />
              {agent.name}
            </button>
          ))}
        </div>

        {mentionedAgents.length > 0 ? (
          <div className="mb-2 px-2 text-xs text-slate-500">
            将指定 {mentionedAgents.map((agent) => agent.name).join("、")} 回复
          </div>
        ) : null}

        {replyTarget ? (
          <div className="mb-2 flex items-center justify-between rounded-md border-l-2 border-blue-500 bg-blue-50 px-3 py-2 text-xs text-blue-900">
            <span className="min-w-0 truncate">
              回复 {replyTarget.role === "user" ? "你" : "Agent"}：{messageSummary(replyTarget.parts)}
            </span>
            <button type="button" onClick={() => setReplyTarget(conversationId, null)} className="grid h-6 w-6 place-items-center rounded hover:bg-blue-100" title="取消引用">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}

        {attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2 px-2">
            {attachments.map((attachment) => (
              <span key={attachment.id} className="flex max-w-[220px] items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
                <File className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{attachment.fileName}</span>
                <button type="button" onClick={() => removePendingAttachment(conversationId, attachment.id)} className="shrink-0" title="移除附件">
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {/* Revise mode banner */}
        {isReviseMode ? (
          <div className="mb-2 flex items-center justify-between rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-sm text-blue-800">
            <span>📝 计划修订模式 — 输入你对当前计划的修改意见</span>
            <button
              onClick={() => setReviseForPlanId(null)}
              className="grid h-6 w-6 place-items-center rounded text-blue-500 hover:bg-blue-100"
              title="退出修订模式"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : pendingPlan ? (
          <button
            onClick={() => { setReviseForPlanId(pendingPlan.id); setDraft(conversationId, ""); }}
            className="mb-2 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-100 w-full"
          >
            📝 对计划有修改意见？点击进入修订模式
          </button>
        ) : null}

        <div className="flex items-end gap-2">
          <textarea
            className="max-h-36 min-h-12 flex-1 resize-none bg-transparent px-3 py-2.5 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400"
            placeholder={
              isReviseMode
                ? "说明你希望如何调整计划，Enter 提交修改意见"
                : "输入消息，@ 指定 Agent，Enter 发送，Shift+Enter 换行"
            }
            value={draft}
            onChange={(event) => setDraft(conversationId, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                if (isReviseMode) setReviseForPlanId(null);
                else setReplyTarget(conversationId, null);
              }
              if (event.key === "Enter" && !event.shiftKey && !composingRef.current && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
          />
          <div className="flex items-center gap-1">
            {!isReviseMode ? (
              <>
                <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => void uploadFiles(event.target.files)} />
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="grid h-10 w-10 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
                  title="上传附件"
                >
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={async () => {
                    const newMode = approvalMode === "auto" ? "review" : "auto";
                    try {
                      const data = await requestJson<{ conversation: Conversation }>(
                        `/api/conversations/${conversationId}`,
                        {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ fsWriteApprovalMode: newMode })
                        }
                      );
                      updateConversation(conversationId, data.conversation);
                    } catch (modeError) {
                      setError(modeError instanceof Error ? modeError.message : "审批模式更新失败。");
                    }
                  }}
                  className={`flex h-10 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${
                    approvalMode === "review"
                      ? "border-amber-200 bg-amber-50 text-amber-700"
                      : "border-emerald-200 bg-emerald-50 text-emerald-700"
                  }`}
                  title={`当前：${approvalMode === "auto" ? "自动写入" : "需审批"}，点击切换`}
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {approvalMode === "auto" ? "Auto" : "Review"}
                </button>
              </>
            ) : null}
            <button
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg text-white transition disabled:cursor-not-allowed disabled:bg-slate-300 ${
                isReviseMode ? "bg-blue-600 hover:bg-blue-700" : "bg-[#4264ff] hover:bg-[#2f50e6]"
              }`}
              type="button"
              disabled={!draft.trim() || submitting}
              onClick={() => void submit()}
              title={isReviseMode ? "提交修改意见" : "发送"}
            >
              <ArrowUp className="h-5 w-5" />
            </button>
          </div>
        </div>
        {error ? <p className="px-2 pb-1 pt-2 text-xs text-red-600">{error}</p> : null}
      </div>
    </footer>
  );
}

function messageSummary(parts: import("@/shared/types").MessagePart[]) {
  const text = parts.find((part) => part.type === "text");
  return text?.type === "text" ? text.content.slice(0, 100) : "附件或结构化消息";
}
