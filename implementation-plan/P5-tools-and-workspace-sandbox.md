# P5 - 工具系统与 Workspace 沙箱

## 目标

实现 Agent-Conference-managed tools，让 Agent 可以安全读写 workspace、运行受控命令，并把工具活动显示为结构化消息 parts。

## 参考文件

- `openspec/specs/tools/spec.md`
- `openspec/specs/platform-security/spec.md`
- `specs/07-tools.md`
- `specs/11-platform.md`
- `skills/add-tool.md`
- `CLAUDE.md` 第 5 节“安全与沙箱”
- `AGENT_BACKEND.md` 第 4、5、6 章

## 范围

需要实现：

- `src/server/tools/types.ts`
- `src/server/tools/registry.ts`
- `src/server/tools/fs-list.ts`
- `src/server/tools/fs-read.ts`
- `src/server/tools/fs-write.ts`
- `src/server/tools/bash.ts`
- `src/server/tools/read-artifact.ts`
- `src/server/tools/write-artifact.ts`
- `src/server/workspace-utils.ts`
- `src/server/security.ts`
- pending write/bash 内存队列和 resolve API

## MVP 工具清单

| 工具 | MVP 目标 |
|---|---|
| `fs_list` | 列 workspace 内目录 |
| `fs_read` | 读取 workspace 内小文本文件 |
| `fs_write` | auto/review 模式写文件 |
| `bash` | 在 effective cwd 内执行受控命令 |
| `read_artifact` | 读取同会话 artifact |
| `write_artifact` | 创建 document/web_app artifact |
| `ask_user` | 可先设计接口，P9 使用 |
| `report_task_result` | P9 使用 |

## 安全规则

1. 所有路径 resolve 后必须在 effective cwd 下。
2. sandbox mode 使用 `workspace.rootPath`。
3. local mode 使用 `workspace.boundPath`，但 MVP 可先只支持 sandbox。
4. Windows 路径比较大小写不敏感。
5. `bash` 必须先匹配 `getBannedPatterns(platform)`。
6. 依赖安装、删除/覆盖、host 状态变更类命令需要审批。
7. review 模式下 `fs_write` 不直接落盘。

## 任务拆分

1. 定义 `ToolDef`、`ToolContext`、`ToolResult`。
2. 实现 registry 和 execute wrapper。
3. 实现 JSON Schema + zod 双校验模式。
4. 实现 workspace path helper。
5. 实现 sandbox 配额扫描。
6. 实现 `fs_list/read/write`。
7. 实现 `bash` 的 Windows/POSIX 命令执行。
8. 实现 pending approvals。
9. 将 tool call/result 接入 MessagePart。

## 验收标准

- `../../` 路径访问被拒绝。
- 写 workspace 外文件被拒绝。
- review 模式产生 `fs_write.pending`。
- 审批通过后才写盘。
- 危险命令被拒绝。
- 命令输出被截断到安全上限。

## 风险

- Windows shell 行为与 POSIX 差异很大，必须按 `specs/11-platform.md` 单独处理。
- 文件扫描必须防 symlink/junction 循环。
