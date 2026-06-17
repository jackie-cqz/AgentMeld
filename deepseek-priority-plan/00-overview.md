# DeepSeek 主线剩余任务总览

本文档组用于替代“必须先完成 Claude/Codex SDK Adapter”的路线。当前项目后续以 **DeepSeek API / OpenAI-compatible Custom Agent** 作为主运行路径，Claude Code 与 Codex Adapter 暂时作为 optional future adapters 保留 stub，不再阻塞 MVP。

## 当前判断

最新 `master` 已经具备一个可继续迭代的本地多 Agent 协作工作空间雏形：

- 基础 Next.js / DB / API / Store / SSE 已成型。
- `CustomAgentAdapter` 已经可以走 OpenAI-compatible Chat Completions。
- 工具注册、文件写入审批、Bash 审批、Artifact、Attachment、Deployment、Orchestrator 基础 DAG 都已有实现。
- `ClaudeCodeAdapter` 与 `CodexAdapter` 当前仍是 stub，但这不是 DeepSeek 主线 MVP 的阻塞项。

## 新优先级原则

1. **DeepSeek 可用性优先**：先让 Custom Agent + DeepSeek 在真实对话、工具调用、编排任务里稳定工作。
2. **Orchestrator 产品闭环优先**：计划生成、计划审批、子任务派发、结果回收、失败处理必须成为可控流程。
3. **上下文工程优先于更多 Adapter**：把 pinned、recent、compact summary、artifact/deploy/attachment 上下文做好，比接更多 SDK 更直接提升效果。
4. **前端状态闭环优先**：任何后端 pending/event 都必须能在 UI 中被看见、被处理、被恢复。
5. **Claude/Codex 只保留扩展位**：UI 与文档中明确标记为“未启用/未来支持”，避免用户误以为已可用。

## 文档结构

- `P0-deepseek-runtime-baseline.md`：DeepSeek 主线运行基线。
- `P1-orchestrator-plan-review.md`：Orchestrator 计划审批闭环。
- `P2-orchestrator-evidence-and-retry.md`：子任务 report、证据门禁、多轮恢复。
- `P3-context-engineering.md`：上下文工程与 compact summary 注入。
- `P4-tool-approval-and-sandbox.md`：工具审批、安全沙箱、Bash/Write 体验。
- `P5-artifact-deployment-and-preview.md`：Artifact、版本、部署预览闭环。
- `P6-frontend-store-and-ui.md`：前端 Store 与组件补全。
- `P7-agent-builder-and-settings.md`：DeepSeek Agent Builder 与设置体验。
- `P8-testing-and-observability.md`：测试、日志、运行诊断。
- `P9-optional-adapters-and-mcp.md`：Claude/Codex optional adapter 与 MCP 扩展位。
- `P10-packaging-and-release.md`：桌面、本地发布、后续扩展。

## 重点参考文件

- 前端参考图：`agent-conference-preview.png`
- 总体后端目标：`AGENT_BACKEND.md`
- 项目规则：`CLAUDE.md`
- OpenSpec 总览：`openspec/project.md`
- Adapter：`specs/05-adapter-interface.md`、`openspec/specs/adapters/spec.md`
- Orchestrator：`specs/06-orchestrator-flow.md`、`specs/16-task-contract-handoff.md`、`specs/17-orchestrator-plan-review.md`、`openspec/specs/orchestrator/spec.md`
- Tools：`specs/07-tools.md`、`openspec/specs/tools/spec.md`
- Frontend：`specs/09-frontend-architecture.md`、`specs/10-agent-builder.md`、`openspec/specs/frontend/spec.md`
- Context：`specs/13-conversation-context.md`、`openspec/specs/conversation-context/spec.md`
- Artifacts：`specs/04-artifacts.md`、`openspec/specs/artifacts/spec.md`
- Platform：`specs/11-platform.md`、`specs/12-desktop-electron.md`

## 完成度目标

当 P0-P7 完成后，项目应达到：

- DeepSeek API 可作为默认主模型稳定运行。
- 单 Agent 与多 Agent 对话可连续完成真实任务。
- Orchestrator 计划必须经过 UI 审批后执行。
- 子任务必须通过 `report_task_result` 或明确失败原因结束。
- compact summary、pinned messages、artifact/deploy references 能进入后续上下文。
- 前端能清晰展示 pending approvals、dispatch progress、artifact/deploy 状态。

P8-P10 属于稳定化、扩展和发布阶段。

## 前端视觉方向

`agent-conference-preview.png` 是当前前端 UI 的主要参考。后续界面应以“本地多 Agent 工作台”为主，而不是 landing page 或营销页。

核心布局：

- 左侧固定导航栏：品牌、主导航、会话搜索、新建会话、会话列表、底部用户/主题入口。
- 中间聊天区：群聊 header、Agent avatar stack、token usage、连接状态、消息流、Orchestrator 总结、底部输入框。
- 右侧 Artifact 工作区：artifact 标题、类型/版本、预览/编辑 tab、iframe 预览、下载/复制/打开/关闭等操作。

视觉语气：

- 白底、浅灰分隔线、蓝色主操作、紧凑生产力工具风格。
- 信息密度高，但分区清楚。
- 卡片只用于消息气泡、会话项、工具/审批/产物等具体对象，不把整页堆成装饰卡片。
- 窄屏时三栏应降级为可切换面板，而不是压缩到重叠。
