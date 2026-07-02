# P2 - 审批队列与用户交互工具闭环

## 对应 specs

- `specs/02-stream-events.md`
- `specs/07-tools.md`
- `specs/09-frontend-architecture.md`
- `specs/14-mobile-remote.md`

## 当前问题

当前 pending queue 后端基础已经存在：

- `src/server/pending-writes.ts`
- `src/server/pending-bash.ts`
- `src/server/dispatch-plan-manager.ts`
- resolve API 已有。
- `src/stores/app-store.ts` 已保存 pending 状态。

但缺口很明显：

- UI 没有 PendingWritesPanel、PendingBashCommandsPanel、DispatchPlanCard 操作入口。
- `bash` 对关键命令当前是 MVP auto-approve，没有真正注册 `PendingBashCommand`。
- 没有 `ask_user` 工具、`pending-questions` 队列、事件和 UI。
- specs 提到刷新后通过 GET pending endpoints 恢复队列，当前只有 resolve API，没有 conversation-scoped GET。

## 需要做的内容

1. 补 pending GET API。
   - `GET /api/conversations/:id/pending-writes`
   - `GET /api/conversations/:id/pending-bash-commands`
   - `GET /api/conversations/:id/pending-dispatch-plans`
   - 后续 `GET /api/conversations/:id/pending-questions`

2. `fs_write` 审批闭环。
   - 保持 review 模式注册 pending write。
   - 发布 `fs_write.pending`。
   - approve 后写盘并发布 resolved。
   - reject 后返回明确工具错误。
   - abort 后清理 pending。

3. `bash` 审批闭环。
   - 命中 banned pattern 继续直接拒绝。
   - 命中关键审批规则时注册 pending bash。
   - 发布 `bash_command.pending`。
   - 用户批准后再执行命令。
   - 拒绝后不执行并返回工具错误。
   - run abort 时发布 resolved 并清 UI。

4. 实现 `ask_user` 工具。
   - 参数限制为 1-3 个问题，每题 2-3 个互斥选项。
   - 注册 PendingQuestion。
   - 发布 `ask_user.pending` 事件。
   - UI 弹卡片/对话框让用户选择或填写 Other。
   - 提交后工具调用继续。

5. 前端审批 UI。
   - ChatPanel 输入框上方显示 pending items。
   - PendingWriteCard 展示 path、agent、old/new diff 入口。
   - PendingBashCard 展示 command、cwd、reason。
   - PendingQuestionCard 展示问题与选项。
   - 所有操作都走 API，最终通过 SSE resolved 清理。

## Spec 07 四个缺失工具详细计划

当前工具 registry 已有：

- `fs_list`
- `fs_read`
- `fs_write`
- `bash`
- `read_artifact`
- `write_artifact`
- `plan_tasks`
- `report_task_result`

Spec 07 中 MVP/核心路径还缺 4 个工具：

- `deploy_artifact`
- `deploy_workspace`
- `read_attachment`
- `ask_user`

这 4 个工具分别影响产物交付、workspace 交付、附件理解和 agent 主动澄清，是后续 Conductor 与移动审批也会复用的基础能力。

### T1. deploy_artifact

建议文件：

- `src/server/tools/deploy-artifact.ts`
- `src/server/deployment-service.ts`
- `src/server/deployment-service.test.ts`
- `src/server/tools/deploy-tools.test.ts`

参数：

```ts
{
  artifactId: string;
  title?: string;
}
```

约束：

- artifact 必须存在。
- artifact 必须属于当前 conversation。
- artifact.type 必须是 `web_app`。
- 只部署 artifact content 中的 files。
- 不运行 npm install/build。

部署目录：

```text
.agentmeld-data/deployments/dep_xxx/
  index.html
  ...
  .agentmeld/
    manifest.json
    source/
```

返回：

```ts
DeployStatusRecord
```

必须包含：

- `id`
- `artifactId`
- `title`
- `version`
- `previewPath`
- `status`
- `sourceType: "artifact"`
- `deploymentType: "local_static" | "external_static"`
- `sourceDownloadPath`
- `containerDownloadPath`
- `summaryInstruction`

外部静态发布：

- 读取 `app_settings.deploymentPublishEnabled`。
- 启用时要求 `deploymentPublishDir` 和 `deploymentPublicBaseUrl` 均非空。
- 只能写 `<publishDir>/<deploymentId>` 子目录。
- 不允许 publishDir 是文件系统根目录。
- 对外返回 `publicUrl/localPreviewPath/publishPath`。

事件接入：

- tool result 返回 DeployStatusRecord。
- CustomAdapter 检测后 emit `deploy.status`。
- AgentRunner 插入 `deploy_status` message part。

### T2. deploy_workspace

建议文件：

- `src/server/tools/deploy-workspace.ts`
- 复用 `deployment-service.ts`

参数：

```ts
{
  path: string;
  title?: string;
}
```

约束：

- path resolve 后必须在 effective workspace 下。
- path 必须是目录。
- 目录内必须有 `index.html`。
- 不允许部署 `node_modules`、`.git`、server source 根、整个源码根。
- 不运行 build 命令，只复制已有静态目录。
- 复制时拒绝路径逃逸和 symlink 越界。

返回：

- `sourceType: "workspace"`
- `workspacePath`
- `artifactId: "workspace:<path>"`
- `version: 0`
- 其它字段同 deploy_artifact。

常见用途：

```text
bash: npm run build
deploy_workspace({ path: "dist", title: "前端构建预览" })
```

### T3. read_attachment

建议文件：

- `src/server/tools/read-attachment.ts`
- `src/server/attachment-service.ts`
- `src/server/attachment-service.test.ts`

参数：

```ts
{
  attachmentId: string;
}
```

约束：

- attachment 必须属于当前 conversation。
- 物理路径必须在 workspace.rootPath 下。
- 文本文件读取上限建议 50,000 字符。
- 二进制文件不直接返回原始 bytes。
- 图片可以返回 metadata，是否返回 base64 由 adapter 多模态路径决定。

返回：

文本附件：

```ts
{
  id,
  fileName,
  mimeType,
  kind: "file",
  content,
  truncated
}
```

图片附件：

```ts
{
  id,
  fileName,
  mimeType,
  kind: "image",
  size,
  pathHint
}
```

注意：

- `read_attachment` 是给 agent 按需读取文件内容的工具。
- 普通 file attachment 不应自动塞进 prompt，避免上下文爆炸。

### T4. ask_user

建议文件：

- `src/server/tools/ask-user.ts`
- `src/server/pending-questions.ts`
- `src/app/api/pending-questions/[id]/answer/route.ts`
- `src/components/pending-question-card.tsx`

事件类型需要补充到 shared types 和 reducer：

```ts
| { type: "ask_user.pending"; pendingQuestion: PendingQuestion }
| { type: "ask_user.resolved"; pendingId: string; answer: UserAnswer }
```

参数：

```ts
{
  questions: Array<{
    id: string;
    header: string;
    question: string;
    options: Array<{
      label: string;
      description: string;
    }>;
  }>;
}
```

限制：

- 一次 1-3 个问题。
- 每题 2-3 个选项。
- header 最多 12 字符。
- label 简短。
- 支持 Other 自由输入，但客户端统一追加，不要求模型提供 Other。

运行机制：

1. handler 校验参数。
2. 注册 PendingQuestion。
3. 发布 `ask_user.pending`。
4. handler await 用户回答。
5. 用户提交后 API resolve。
6. 发布 `ask_user.resolved`。
7. handler 返回结构化答案给 agent。

适用场景：

- 需求范围不明确。
- 风格/平台/风险选择需要用户确认。
- 高影响操作前需要选择路线。

禁止滥用：

- 普通寒暄不要问。
- agent 能保守判断时不要问。
- 开放式长问答不适合 ask_user。

## Pending Queue 通用设计

建议把 pending queues 统一成相似接口：

```ts
register(...)
get(id)
getAll()
getForConversation(conversationId)
resolve(id, payload)
cancelForRun(runId)
clearForTests()
```

每个 pending item 都应包含：

- id
- conversationId
- agentId
- runId
- createdAt

UI 刷新恢复：

- StreamProvider bootstrap 之后调用 pending GET endpoints。
- 或 bootstrap payload 直接包含当前 pending items。

Abort 行为：

- run abort 时调用对应 `cancelForRun(runId)`。
- 发布 resolved 事件清 UI。
- 工具调用收到 rejection，返回 `{ ok:false, error:"..." }`。

## 审批 UI 组件拆分

建议组件：

- `PendingApprovalsPanel`
- `PendingWriteCard`
- `PendingWriteDiffView`
- `PendingBashCommandCard`
- `PendingQuestionCard`
- `PendingDispatchPlanCard`，实际详情在 P3。

摆放：

- 在 ChatPanel 中 MessageInput 上方。
- 当前 conversation 有 pending 时显示。
- 多个 pending 按 createdAt 升序。
- 不使用 toast 替代，因为 pending 是对话工作流的一部分。

## 验收标准

- review 模式下 `fs_write` 不会直接落盘。
- approve 后文件内容才改变。
- reject 后文件不变，tool_result 为错误。
- 关键 bash 命令会暂停等待用户批准。
- 拒绝 bash 时命令不会执行。
- 页面刷新后仍能从 GET pending endpoint 恢复未决审批。
- ask_user 可以暂停 run 并在用户回答后继续。

## 不在本优先级范围

- 不做移动端审批。
- 不做外部 MCP 工具审批。
- 不做复杂三方 diff 编辑，只做 approve/reject。
