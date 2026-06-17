# P3 - 上下文工程与 Compact Summary 注入

## 目标

把上下文工程从“recent + pinned + token budget”升级为“recent + pinned + compact summaries + artifacts + deployments + attachments”的统一模型输入策略。

## 当前基础

`src/server/conversation-context.ts` 已支持 recent、pinned、artifact_ref、deploy_status、附件占位和 token budget。`src/app/api/conversations/[id]/compact/route.ts` 已能生成 summary，但 summary 尚未进入 `buildHistoryFor` 主流程。

## 参考文件

- `src/server/conversation-context.ts`
- `src/app/api/conversations/[id]/compact/route.ts`
- `src/server/conversation-service.ts`
- `src/server/attachment-service.ts`
- `src/server/tools/read-attachment.ts`
- `specs/13-conversation-context.md`
- `openspec/specs/conversation-context/spec.md`

## 具体任务

1. 将 compact summary 注入 `buildHistoryFor`。
   - 读取当前 conversation 的 context summaries。
   - 按 Spec 13 作为最早的一条 user role context message 放在 recent history 前。
   - 标记 covered range，避免重复压缩内容和 recent 内容冲突。
   - 注入顺序为 summary -> pinned messages -> 未被 summary 覆盖的 recent messages -> current user。

2. 改进 summary 生成质量。
   - 当前 summary 是简单拼接。
   - DeepSeek 可用后，可增加 LLM summary 模式。
   - summary 必须保留用户目标、关键决策、产物 ID、未完成事项。

3. 引入上下文分层。
   - system prompt：角色、工具、工作区、安全规则。
   - durable context：compact summary、pinned messages。
   - recent context：最近完整消息。
   - task context：Orchestrator 子任务 prompt。

4. 改进 group chat 中的 agent 标识。
   - 当前其他 agent 消息可能用 agentId。
   - 应尽量使用 agent name + id。
   - 避免模型把其他 agent 的输出误认为用户指令。
   - 群聊 custom agent 的 system prompt 末尾追加 `[AgentName]` 前缀语义说明。

5. 附件上下文策略。
   - 消息历史里只放附件 metadata。
   - 模型需要内容时调用 `read_attachment`。
   - 文本附件可在小文件时自动摘要，大文件必须工具读取。

6. 子任务上下文隔离。
   - Orchestrator 分派的子 agent 不再注入完整 `buildHistoryFor`。
   - 子任务 prompt 只包含 recent conversation 摘要、pinned、upstream artifacts、existing artifacts 和任务合同。
   - upstream/existing artifacts 只列 id/title/type，不内联全文。

7. UsageBadge 与上下文可视化。
   - 展示最近一次 run 的 input/output/cache token。
   - 展示当前 context used / ceiling 估算。
   - 超过 50% / 80% 做颜色提示。

## 验收标准

- compact 后，旧消息可以不进入 recent，但 summary 会进入模型上下文。
- pinned messages 不会被 token budget 删除。
- artifact/deploy reference 会以稳定格式进入上下文。
- 附件不会直接把大文件塞进 prompt。
- Orchestrator 子任务不会看到完整群聊历史，只看被包装后的任务上下文。
- 有测试覆盖 token budget、pinned、summary、artifact_ref、attachment 协同。
