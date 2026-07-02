# Specs 对照缺口总览

本文件夹基于 `specs/` 逐项对照当前 `src/` 实现后生成。判断口径：

- 以当前代码事实为准，不直接沿用 specs 中“已实现”的描述。
- “完成”必须满足后端、API、状态流、UI 操作入口和测试至少形成一个可用闭环。
- Electron、Mobile、External MCP、Search 等大范围能力如果只有 specs，没有代码实现，统一归入后续优先级。

## 最近验证结果

- `npm run typecheck` 通过。
- `npm test -- --run` 通过，24 个测试文件、253 个测试全部通过。
- `npm run lint` 通过，但有 26 个 warning。
- `npm run build` 通过。
- 当前目录不是 git 仓库，无法用 git diff 辅助确认变更边界。

## Specs 与当前代码的核心偏差

| Spec | 主题 | 当前完成度 | 主要缺口 |
|---|---|---|---|
| 01 | 核心实体 | 高 | attachments 只有 schema/type，占位 UI；builtin agent 可改策略与代码不一致。 |
| 02 | StreamEvent | 中高 | dispatch review、bash pending、deploy status 等事件未完整闭环。 |
| 03 | MessagePart | 中 | markdown/code/tool 卡片较简化；attachment、deploy candidates、撤回/编辑缺失。 |
| 04 | Artifacts | 中 | artifact 来源职责冲突；版本链 UI、deploy、code_file、ppt export 缺失。 |
| 05 | Adapter | 中低 | 只有 mock/custom；ClaudeCode/Codex adapter 不存在；AdapterInput 与 spec 漂移。 |
| 06 | Conductor | 低 | service 骨架存在，但未接入 AgentRunner 主流程。 |
| 07 | Tools | 中 | deploy/read_attachment/ask_user 缺失；bash 审批未真正接入。 |
| 08 | DB schema | 高 | 表大体齐全；缺搜索 FTS、device sessions、MCP server 等后续表。 |
| 09 | Frontend | 中低 | 三栏 UI 有雏形；AgentLibrary/ArtifactLibrary/审批面板/文件视图/搜索缺失。 |
| 10 | Agent Builder | 中低 | API 与 dialog 有，但未挂 UI；工具列表与 spec 不一致。 |
| 11 | Platform | 中 | 路径/黑名单已有；local workspace、目录选择、进程清理升级不完整。 |
| 12 | Electron | 低 | 当前没有 Electron 目录、脚本和打包链路。 |
| 13 | Context | 低 | 没有 `conversation-context.ts`，history/pin/token budget/compact 未实现。 |
| 14 | Mobile | 未实现 | 没有 `apps/mobile`、pairing、mobile API、鉴权。 |
| 15 | External MCP | 未实现 | spec 明确是设计提案，当前没有数据模型和接线。 |
| 16 | Search | 未实现 | 没有 FTS 表、search service/API/store/UI。 |
| 16 task | Handoff | 低 | task contract 类型部分存在，但 outputKey、artifact binding、验收语义未实现。 |
| 17 | Plan Review | 低 | pending plan 队列/API 有雏形，但主流程和 UI 未闭环。 |

## 推荐优先级

| 文档 | 优先级 | 目标 |
|---|---|---|
| `P0-runtime-consistency-and-spec-drift.md` | P0 | 先修会导致 run 失败或文档误导的硬问题。 |
| `P1-adapter-input-context-and-artifact.md` | P1 | 统一 AdapterInput、runId、history、artifact 写入职责。 |
| `P2-approval-queues-and-user-prompts.md` | P2 | 补齐 fs_write、bash、ask_user、pending APIs 和 UI 审批闭环。 |
| `P3-conductor-plan-review-and-handoff.md` | P3 | 让 Conductor 真正走 plan review -> child runs -> aggregate。 |
| `P4-artifacts-deployments-and-versioning.md` | P4 | 补 artifact 预览、版本、部署、导出和 library。 |
| `P5-agent-builder-and-settings.md` | P5 | 挂载 Agent Builder 和 Settings，修正 agent 配置约束。 |
| `P6-frontend-architecture-completion.md` | P6 | 补 store/UI 架构中缺的 tab、pending panel、pin/edit/withdraw、文件视图。 |
| `P7-attachments-search-and-context.md` | P7 | 实现附件、全文搜索、上下文历史和 compact。 |
| `P8-sdk-adapters-and-mcp-bridge.md` | P8 | ClaudeCode/Codex adapters 与内部 MCP bridge。 |
| `P9-platform-local-workspace-and-desktop.md` | P9 | local workspace、跨平台加固、Electron。 |
| `P10-mobile-external-mcp-and-release.md` | P10 | 移动伴随端、外部 MCP、发布收尾。 |

## MVP 收敛建议

如果目标是尽快得到一个可信的 Web MVP，建议先完成 P0-P5。P6-P7 是体验和长期上下文层，P8-P10 是扩展平台层，容易把范围拉大。

