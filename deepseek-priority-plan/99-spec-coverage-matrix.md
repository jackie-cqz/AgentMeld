# Specs 覆盖矩阵

本文档对照 `specs/` 编号规格，检查 `deepseek-priority-plan/` 是否覆盖对应需求。结论是：DeepSeek 主线 MVP 已覆盖大部分核心链路，但原计划对若干非主线规格写得过粗，需要补充明确任务。

## 总体结论

| Spec | 主题 | 覆盖状态 | 对应计划文档 | 主要缺口 |
|---|---|---|---|---|
| Spec 01 | 核心实体 | 部分覆盖 | P0, P7, P10 | 需要显式校验实体约束、ID 前缀、parentRunId、supportsVision、workspace/attachment 规则 |
| Spec 02 | StreamEvent | 部分覆盖 | P0, P6, P8 | 需要补齐事件注入路径、`dispatch.plan`、`message.usage`/usage 字段、重连补偿、未配对 tool_result 兜底 |
| Spec 03 | MessagePart | 部分覆盖 | P5, P6 | 缺 `deploy_candidates`、code part、编辑/撤回、工具卡合并、artifact lazy load 等组件级任务 |
| Spec 04 | Artifacts | 部分覆盖 | P5 | 需补 PPT、code_file、version compare、source/container download、外部静态发布、安全 CSP |
| Spec 05 | Adapter | 部分覆盖 | P0, P9 | DeepSeek Custom 主线覆盖，但 Claude/Codex 与 spec 目标不一致；需标记 spec drift 和 optional 策略 |
| Spec 06 | Orchestrator | 部分覆盖 | P1, P2, P3 | 需补 plan_tasks 捕获、compileDispatchPlan、Stage 3 LLM 聚合、子任务上下文隔离 |
| Spec 07 | Tools | 大部分覆盖 | P4, P5, P7 | 需补确定性部署命令、pending question UI、read_attachment PDF/二进制策略、工具提示注入 |
| Spec 08 | DB Schema | 部分覆盖 | P0, P8, P10 | 需补 migration/bootstrap、context summaries、search FTS、app_settings deployment 字段 |
| Spec 09 | Frontend | 部分覆盖 | P6 | 需补 normalized store、DispatchPlanCard、文件/diff tabs、UsageBadge、编辑撤回、全局搜索 |
| Spec 10 | Agent Builder | 大部分覆盖 | P7 | 需补对话创建草稿、工具预设、provider matrix、内置 agent 编辑/不可删 |
| Spec 11 | Platform | 部分覆盖 | P4, P10 | 需补 Windows/POSIX shell 细节、DirPicker、敏感路径、symlink/junction 防循环 |
| Spec 12 | Electron | 粗覆盖 | P10 | 需补 Next standalone、better-sqlite3 ABI、userData 路径、打包脚本和验证清单 |
| Spec 13 | Context | 大部分覆盖 | P3 | 需补 summary 注入顺序、covered range、子任务跳过 buildHistoryFor、UsageBadge |
| Spec 14 | Mobile | 粗覆盖 | P10 | 需补 companion mode、设备 token、mobile API、Capacitor 信息架构 |
| Spec 15 | External MCP | 粗覆盖 | P9 | 需补 mcp_servers 数据模型、per-agent opt-in、custom MCP 客户端阶段、信任审批 |
| Spec 16 | Message Search | 未覆盖 | P6, P8 | 需要新增 FTS5、搜索 API、search store、全局搜索 UI 和测试 |
| Spec 16 | Task Contract | 部分覆盖 | P2 | 需补 outputKey、inputs -> dependsOn、expectedOutputs 校验、UI contract metadata |
| Spec 17 | Plan Review | 部分覆盖且有语义偏差 | P1, P6 | 原计划写成结构化编辑，spec 要求会话式 revision；需改为 read-only plan + composer feedback |

## 需要补入计划的关键点

1. **P0 增加规格一致性基线**：实体约束、schema 字段、StreamEvent 类型与 DeepSeek runtime 一起作为基础验收。
2. **P1 修正计划审批语义**：按 Spec 17 改为 read-only plan、approve/reject、composer 自然语言 revise，而不是前端结构化编辑 DAG。
3. **P2 增加任务合约**：`expectedOutputs`、`inputs`、`outputKey`、acceptance criteria、missing report failed。
4. **P5 扩展 Artifact/Deploy**：PPT、版本对比、部署候选、源码包/容器包、外部静态发布。
5. **P6 增加 Spec 09/16 前端任务**：normalized store、DispatchPlanCard、global search、message edit/withdraw。
6. **P8 增加 DB/FTS/search 测试**：Spec 16 搜索主要落在 P8。
7. **P9/P10 明确非 MVP specs**：External MCP、Mobile、Electron 不阻塞 DeepSeek MVP，但需要详细未来任务。

## DeepSeek 主线下的覆盖策略

- `custom + deepseek` 是当前唯一必须打通的 adapter。
- `claude-code` / `codex` 与 Spec 05 的“已实现”描述存在现实偏差；计划中按 optional future adapters 处理。
- Spec 14/15/12 属于发布和扩展层，不进入 DeepSeek MVP 的 P0-P7 阻塞项，但 P9/P10 必须保留完整路线。
- Spec 16 message search 是产品可用性功能，虽然不影响 LLM 运行，但属于明显漏项，建议纳入 P8。
