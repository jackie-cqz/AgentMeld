"use client";

import { ArrowUp, AtSign, Check, ChevronDown, File, Loader2, Paperclip, Pencil, ShieldCheck, Users, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Popover } from "@/components/ui/popover";
import { requestJson } from "@/lib/request-json";
import { getAgentAvatarLabel, getAgentAvatarStyle } from "@/shared/agent-avatar";
import { useAppStore } from "@/stores/app-store";
import { selectConversationPendingDispatchPlans } from "@/stores/selectors";
import type { Agent, Attachment, Conversation, MessagePart } from "@/shared/types";

const EMPTY_ATTACHMENTS: Attachment[] = [];

export function MessageInput({ conversationId, agents }: { conversationId: string; agents: Agent[]; rightPanelOpen?: boolean; rightPanelWidth?: number }) {
  const draft = useAppStore(state => state.composerDraftByConversation[conversationId] ?? "");
  const setDraft = useAppStore(state => state.setComposerDraft);
  const sendMessage = useAppStore(state => state.sendMessage);
  const replyTargetId = useAppStore(state => state.replyTargetByConversation[conversationId] ?? null);
  const replyTarget = useAppStore(state => replyTargetId ? state.messages[replyTargetId] ?? null : null);
  const setReplyTarget = useAppStore(state => state.setReplyTarget);
  const attachments = useAppStore(state => state.pendingAttachmentsByConversation[conversationId] ?? EMPTY_ATTACHMENTS);
  const addPendingAttachment = useAppStore(state => state.addPendingAttachment);
  const removePendingAttachment = useAppStore(state => state.removePendingAttachment);
  const approvalMode = useAppStore(state => state.conversations[conversationId]?.fsWriteApprovalMode ?? "auto");
  const updateConversation = useAppStore(state => state.updateConversation);
  const pendingPlans = useAppStore(useShallow(state => selectConversationPendingDispatchPlans(state, conversationId)));
  const [mentionedIds, setMentionedIds] = useState<string[]>([]);
  const [recipientMenu, setRecipientMenu] = useState<{ x: number; y: number } | null>(null);
  const [revisePlanId, setRevisePlanId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [updatingMode, setUpdatingMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionedAgents = useMemo(() => agents.filter(agent => mentionedIds.includes(agent.id)), [agents, mentionedIds]);
  const pendingPlan = pendingPlans[0] ?? null;
  const revising = revisePlanId !== null && pendingPlan?.id === revisePlanId;
  const primaryAgent = mentionedAgents[0] ?? agents.find(agent => agent.isConductor) ?? agents[0];

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(180, Math.max(56, textarea.scrollHeight))}px`;
  }, [draft]);

  const submit = async () => {
    if (!draft.trim() || submitting || uploading) return;
    setSubmitting(true);
    setError(null);
    try {
      if (revising && pendingPlan) {
        await requestJson(`/api/dispatch-plans/${pendingPlan.id}/resolve`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "revise", feedback: draft.trim() })
        });
        setDraft(conversationId, "");
        setRevisePlanId(null);
      } else {
        await sendMessage(conversationId, draft.trim(), { mentionedAgentIds: mentionedAgents.map(agent => agent.id), attachmentIds: attachments.map(item => item.id), parentMessageId: replyTargetId });
        setMentionedIds([]);
      }
      textareaRef.current?.focus();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "发送失败。"); }
    finally { setSubmitting(false); }
  };
  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length || uploading) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.set("file", file);
        formData.set("conversationId", conversationId);
        const data = await requestJson<{ attachment: Attachment }>("/api/attachments", { method: "POST", body: formData });
        addPendingAttachment(conversationId, data.attachment);
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "附件上传失败。"); }
    finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = ""; }
  };
  const toggleApproval = async () => {
    if (updatingMode) return;
    setUpdatingMode(true);
    setError(null);
    try {
      const data = await requestJson<{ conversation: Conversation }>(`/api/conversations/${conversationId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fsWriteApprovalMode: approvalMode === "auto" ? "review" : "auto" })
      });
      updateConversation(conversationId, data.conversation);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "审批模式更新失败。"); }
    finally { setUpdatingMode(false); }
  };

  return <footer className="workspace-composer">
    <div className="workspace-composer-inner">
      {pendingPlan ? <div className="workspace-compose-notice">
        <Pencil size={13} /><span>{revising ? "正在修订编排计划" : "编排计划待确认"}</span>
        <button type="button" onClick={() => setRevisePlanId(revising ? null : pendingPlan.id)}>{revising ? "取消修订" : "修改计划"}</button>
      </div> : null}
      <div className="workspace-compose-box">
        {replyTarget ? <div className="workspace-compose-reply"><span>回复 {replyTarget.role === "user" ? "我" : "Agent"} · {messageSummary(replyTarget.parts)}</span>
          <button className="ui-icon-button" title="取消引用" onClick={() => setReplyTarget(conversationId, null)}><X size={13} /></button></div> : null}
        {attachments.length ? <div className="workspace-compose-attachments">{attachments.map(item => <span key={item.id}><File size={13} /><span>{item.fileName}</span>
          <button type="button" title={`移除附件 ${item.fileName}`} onClick={() => removePendingAttachment(conversationId, item.id)}><X size={13} /></button></span>)}</div> : null}
        <textarea ref={textareaRef} aria-label={revising ? "计划修改意见" : "消息"} placeholder={revising ? "描述你希望调整的计划…" : "输入消息，或描述一个任务…"}
          value={draft} onChange={event => setDraft(conversationId, event.target.value)}
          onKeyDown={event => {
            if (event.key === "Escape") { if (revising) setRevisePlanId(null); else setReplyTarget(conversationId, null); }
            if (event.key === "Enter" && !event.shiftKey && !composingRef.current && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
          }}
          onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} />
        <div className="workspace-compose-toolbar">
          <div className="workspace-compose-options">
            <input ref={fileInputRef} type="file" multiple hidden onChange={event => void uploadFiles(event.target.files)} />
            <button className="ui-icon-button" type="button" title="上传附件" disabled={uploading || submitting} onClick={() => fileInputRef.current?.click()}>{uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}</button>
            <button className="workspace-recipient-trigger" type="button" title="选择回复 Agent" aria-expanded={recipientMenu !== null} onClick={event => {
              const rect = event.currentTarget.getBoundingClientRect(); setRecipientMenu({ x: rect.left, y: rect.top - Math.min(360, agents.length * 48 + 90) - 8 });
            }}>
              {mentionedAgents.length ? <AtSign size={14} /> : <Users size={14} />}<span>{mentionedAgents.length ? mentionedAgents.map(agent => agent.name).join("、") : agents.length > 1 ? "团队协作" : primaryAgent?.name ?? "Agent"}</span><ChevronDown size={12} />
            </button>
          </div>
          <div className="workspace-compose-options">
            {!revising ? <button type="button" title={`当前：${approvalMode === "auto" ? "自动写入" : "需审批"}，点击切换`} aria-label="自动审批" aria-pressed={approvalMode === "auto"} disabled={updatingMode || submitting}
              className="workspace-approval-mode" onClick={() => void toggleApproval()}>{updatingMode ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}<span>{approvalMode === "auto" ? "Auto" : "Review"}</span></button> : null}
            <button className="workspace-send" type="button" title={revising ? "提交修改意见" : "发送"} disabled={!draft.trim() || submitting || uploading} onClick={() => void submit()}>{submitting ? <Loader2 size={17} className="animate-spin" /> : <ArrowUp size={18} />}</button>
          </div>
        </div>
      </div>
      <div className="workspace-compose-status"><span title={primaryAgent?.modelId || "未配置模型"}>{primaryAgent?.modelId || primaryAgent?.adapterName || "未配置模型"}</span><span>{uploading ? "附件上传中…" : mentionedAgents.length ? `已指定 ${mentionedAgents.length} 位 Agent` : `${agents.length} 位 Agent`}</span></div>
      {error ? <p className="workspace-compose-error" role="alert">{error}</p> : null}
    </div>
    {recipientMenu ? <Popover {...recipientMenu} label="选择回复 Agent" className="workspace-recipient-menu" onClose={() => setRecipientMenu(null)}>
      <button className="workspace-recipient-option" onClick={() => setMentionedIds([])}><Users size={17} /><span><strong>团队协作</strong><small>由会话默认规则分派</small></span>{!mentionedAgents.length ? <Check size={15} /> : null}</button>
      <div className="workspace-recipient-list">{agents.map(agent => <label className="workspace-recipient-option" key={agent.id}>
        <span className={`workspace-team-avatar ${getAgentAvatarStyle(agent).solid}`}>{getAgentAvatarLabel(agent)}</span><span><strong>{agent.name}</strong><small>{agent.modelId || agent.adapterName}</small></span>
        <input type="checkbox" aria-label={`@${agent.name}`} checked={mentionedIds.includes(agent.id)} onChange={() => setMentionedIds(current => current.includes(agent.id) ? current.filter(id => id !== agent.id) : [...current, agent.id])} />
      </label>)}</div>
    </Popover> : null}
  </footer>;
}

function messageSummary(parts: MessagePart[]) {
  const text = parts.find(part => part.type === "text");
  return text?.type === "text" ? text.content.slice(0, 100) : "附件或结构化消息";
}
