# AgentMeld 工具系统

> 新增工具、审批流程、Conductor 编排的完整参考。

## 工具列表

| 工具 | 分类 | 用途 |
|------|------|------|
| `fs_list` | 文件 | 列出工作区目录 |
| `fs_read` | 文件 | 读取文本文件 |
| `fs_write` | 文件 | 写入文本文件（需审批） |
| `bash` | 命令 | 执行 Shell（需审批，黑名单过滤） |
| `write_artifact` | 产物 | 创建 document/web_app/image/ppt |
| `read_artifact` | 产物 | 读取已有产物 |
| `deploy_artifact` | 部署 | 部署产物预览 |
| `deploy_workspace` | 部署 | 部署工作区构建结果 |
| `ask_user` | 交互 | 结构化提问（暂停 run 等回答） |
| `read_attachment` | 交互 | 读取用户上传附件 |
| `plan_tasks` | 编排 | Conductor 拆解任务计划 |
| `report_task_result` | 编排 | 子 Agent 完成报告（必须调用） |

## 新增工具

### 1. 定义

`src/server/tools/your-tool.ts`：

```typescript
import { z } from "zod";
import type { ToolDef } from "@/server/tools/types";

const ArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string()
});

export const yourTool: ToolDef = {
  name: "your_tool",
  description: "LLM 会读这个来判断何时调用。",
  parameters: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "文件路径" },
      content: { type: "string", description: "文本内容" }
    }
  },
  async handler(args, ctx) {
    const parsed = ArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` };
    }
    // ctx: { conversationId, workspacePath, agentId, runId, abortSignal }
    return { ok: true, value: { result: "success" } };
  }
};
```

### 2. 注册

`src/server/tools/registry.ts` 末尾：

```typescript
import { yourTool } from "@/server/tools/your-tool";
toolRegistry.register(yourTool);
```

### 3. 加入默认集

`src/shared/agent-constants.ts`：

```typescript
export const ALL_TOOL_NAMES = ["your_tool", /* ...existing... */];
```

### 4. 测试

```typescript
import { toolRegistry } from "@/server/tools/registry";

it("handles valid args", async () => {
  const result = await toolRegistry.execute("your_tool",
    { path: "test.txt", content: "hello" },
    { conversationId: "c1", workspacePath: "/tmp", agentId: "a1",
      runId: "r1", abortSignal: new AbortController().signal }
  );
  expect(result.ok).toBe(true);
});
```

## 审批（需要时）

### 注册 → 等待 → 执行

```typescript
// 读取会话审批模式
const conversation = getConversation(ctx.conversationId);
const approvalMode = conversation?.fsWriteApprovalMode ?? "auto";

if (approvalMode === "auto") {
  // 直接执行
  return { ok: true, value: { applied: "auto" } };
}

// Review 模式：注册审批，等待用户决定
const approved = await registerPendingWrite(
  ctx.conversationId, ctx.agentId, ctx.runId,
  filePath, absolutePath, oldContent, newContent
);
if (!approved) return { ok: false, error: "User rejected." };
// 用户批准后继续执行
```

### 流程

```
registerPendingWrite()
  → persistApproval(DB)      ← 持久化到 pending_approvals
  → eventBus.publish(SSE)    ← 推送到前端
  → 返回 Promise，等待 resolver

用户点击 approve/reject
  → API: POST /api/pending-writes/:id/resolve
  → resolveApproval(DB)      ← UPDATE WHERE status='pending' (防重复)
  → resolver(true/false)     ← Promise 解开
```

### 启动恢复

`run-recovery.ts` 启动时：`interruptAllPendingApprovals()` → 所有 `pending` → `interrupted`

## 安全

- **路径**：`assertPathWithinWorkspace` + `realpath` 防 symlink 逃逸
- **命令**：`bash` 执行前匹配平台黑名单（`rm -rf /`、`format C:` 等）
- **配额**：sandbox 模式 1GB / 50000 文件

## Conductor 编排

### plan_tasks

```typescript
{
  reasoning: string;           // 计划说明
  tasks: Array<{
    id: string;                // t1, t2, ...
    agentId: string;           // 必须从可用列表选
    title: string;
    prompt: string;            // 完整任务指令
    dependsOn?: string[];      // 空 = 可并发
    expectedOutputs?: Array<{ id: string; type: string }>;
    acceptanceCriteria?: string[];
    maxAttempts?: number;      // 默认 1
  }>;
}
```

三层 ID 校验：Prompt 约束 → `compileAndValidateDispatchPlan()` → 审批 Gate 二次校验。

DAG 执行：`topologicalWaves(plan)` → 同 wave 并发，跨 wave 串行。同 wave 文件冲突自动标记 blocked。

### report_task_result

```typescript
{
  status: "complete" | "failed" | "blocked";
  summary: string;
  acceptanceResults?: Array<{ criterion: string; passed: boolean; evidence: string }>;
  artifacts?: Record<string, string>;  // outputKey → artifactId
  files?: Array<{ path: string; action: string }>;
  commands?: Array<{ command: string; exitCode: number }>;
}
```

子 Agent 结束前**必须**调用。未调用 = 任务判定失败。子 Agent system prompt 强制注入此工具指引。

## 相关文件

| 文件 | 内容 |
|------|------|
| `src/server/tools/types.ts` | ToolDef / ToolContext / ToolResult |
| `src/server/tools/registry.ts` | ToolRegistry |
| `src/server/tools/orchestrator-tools.ts` | plan_tasks + report_task_result |
| `src/server/orchestrator-service.ts` | DAG 执行 + Recovery |
| `src/server/dispatch-plan.ts` | compileAndValidateDispatchPlan |
| `src/server/pending-writes.ts` | fs_write 审批 |
| `src/server/pending-bash.ts` | bash 审批 |
| `src/server/dispatch-plan-manager.ts` | plan 审批 |
| `specs/07-tools.md` | 工具规格 |
