# P8 - 测试、日志与运行诊断

## 目标

让项目在继续加功能时不失控。建立覆盖核心链路的测试、运行日志和最小诊断能力。

## 当前基础

仓库已有较多 test 文件，`pnpm typecheck`、`pnpm test`、`pnpm build` 当前返回 0。下一步需要把关键业务闭环纳入测试，而不是只测单个工具或 API。

## 参考文件

- `src/server/agent-runner.test.ts`
- `src/server/tools/tools.test.ts`
- `src/server/tools/orchestrator-tools.test.ts`
- `src/server/dispatch-plan-manager.test.ts`
- `src/stores/app-store.test.ts`
- `src/app/api/*.test.ts`
- `vitest.config.ts`

## 具体任务

1. DeepSeek adapter mock 测试。
   - mock streaming text。
   - mock tool_calls。
   - mock API error。
   - 验证事件顺序。

2. Orchestrator integration test。
   - plan pending。
   - approve 后 dispatch。
   - child report complete。
   - missing report failed。
   - retry failed task。

3. Store event replay test。
   - run.start -> message.start -> part.delta -> tool.call -> artifact.create -> deploy.status -> run.end。
   - pending add/remove。
   - SSE 重连后 bootstrap 合并状态。

4. 日志与诊断。
   - runId、conversationId、agentId 进入关键日志。
   - Adapter error 保留 provider/status，不记录 API Key。
   - Orchestrator aggregate message 可用于用户层诊断。

5. CI 风格命令固定。
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm build`
   - 可选 `pnpm lint`

6. DB migration / bootstrap 测试。
   - DB schema 与 `specs/08-db-schema.md` 保持同步。
   - packaged 首启时能 `CREATE TABLE IF NOT EXISTS` 并 seed builtin agents。
   - schema 新增字段要有可重入迁移脚本。

7. Message search 测试。
   - 新增 SQLite FTS5 `messages_fts` 虚拟表和触发器。
   - 测试 streaming 消息不索引，complete/error/aborted 终态才索引。
   - 测试中文 1-2 字 LIKE fallback、中文 3+ 字 FTS、英文 prefix、conversationId/role filter。
   - 测试点击搜索结果后跳转并高亮。

8. Stream replay / recovery 测试。
   - reducer 处理重复事件保持幂等。
   - pending queues 刷新后可通过 GET API 恢复。
   - run failed/aborted 时 tool_use 有本地兜底 tool_result。

9. 前端视觉与交互回归。
   - 用 Playwright 截图验证桌面三栏布局。
   - 验证 Sidebar 当前会话选中态、ChatHeader usage/连接状态、Composer 按钮不重叠。
   - 验证右侧 Artifact iframe 非空、可关闭、tab 切换正常。
   - 验证窄屏下 sidebar/chat/artifact 不互相遮挡。
   - 参考 `agent-conference-preview.png` 建立人工检查清单，不要求像素级一致，但要求信息层级一致。

## 验收标准

- 核心运行链路有集成测试。
- Orchestrator 的失败路径有测试。
- 前端 Store 对新增事件有测试。
- 构建和测试命令作为每次提交前检查项。
- 搜索、迁移、事件恢复都有测试覆盖。
- 前端主要工作台布局有截图或手动验收记录。
