# P0 - 运行一致性与 Spec 漂移修复

## 对应 specs

- `specs/01-core-entities.md`
- `specs/02-stream-events.md`
- `specs/04-artifacts.md`
- `specs/05-adapter-interface.md`
- `specs/08-db-schema.md`
- `specs/09-frontend-architecture.md`
- `specs/12-desktop-electron.md`

## 当前问题

当前代码能够通过 typecheck/test/lint/build，但 specs 中有若干“写成已实现”的能力并不存在，且部分实现细节可能在真实运行时触发错误。

最重要的运行风险：

- `write_artifact` 工具已经写 DB，CustomAdapter 又发 `artifact.create`，AgentRunner 再写一次 DB，存在 duplicate insert 风险。
- `ToolContext.runId` 在 CustomAdapter 中是空字符串，pending 队列和 abort cleanup 无法可靠关联 run。
- `specs/05-adapter-interface.md` 声称 ClaudeCodeAdapter/CodexAdapter 已实现，但代码中没有对应文件和 registry 注册。
- `README.zh-CN.md` 和 `specs/12-desktop-electron.md` 描述 Electron/Mobile/SDK adapter 能力较完整，但根目录没有 `electron/`、`apps/mobile/` 等实现。
- `src/app/api/agents/route.ts` 有未使用 import，多个文件有 lint warning，短期不影响运行，但会干扰交付质量判断。

## 需要做的内容

1. 修复 artifact 创建职责冲突。
   - 推荐方案：工具负责 DB 写入，Adapter 只在工具返回 artifactId 后读取完整 artifact row 并发事件。
   - AgentRunner 收到 `artifact.create` 时只负责注入 `artifact_ref`，不要再次插入已有 artifact。
   - 或者改成工具不写 DB，全部由 AgentRunner 持久化。二者只能选一个。

2. 给 AdapterInput 增加真实 runId。
   - 在 `src/server/adapters/types.ts` 中加入 `runId`。
   - `src/server/agent-runner.ts` 构造 input 时传真实 run id。
   - `src/server/adapters/custom-agent-adapter.ts` 中 ToolContext 使用 `input.runId`。

3. 校准 spec/README 的状态描述。
   - 在 README 增加“当前代码实现状态”。
   - Electron/Mobile/ClaudeCode/Codex 标记为 planned/deferred，除非后续实际实现。
   - 在 `specs/05-adapter-interface.md` 或新状态文档中注明当前只有 Mock/Custom。

4. 清理明显 lint warning。
   - 删除未使用 import/变量。
   - 对故意未用参数统一命名或调整 ESLint 配置。

5. 增加回归测试。
   - CustomAdapter 调 `write_artifact` 后不应 duplicate insert。
   - ToolContext 中 runId 必须是当前 run。
   - artifact.create 事件应产生 artifact_ref part。

## 验收标准

- `npm run typecheck` 通过。
- `npm test -- --run` 通过。
- `npm run lint` 无 warning 或只保留明确豁免项。
- `npm run build` 通过。
- Custom agent 调用 `write_artifact` 时，DB 中只出现一条 artifact。
- message.parts 中包含对应 `artifact_ref`。
- README 不再宣称未实现的桌面/移动/SDK adapter 已可用。

## 不在本优先级范围

- 不实现 ClaudeCode/Codex adapter。
- 不实现 Electron。
- 不实现完整 artifact version/deploy。
- 不重构整个 store 架构。

