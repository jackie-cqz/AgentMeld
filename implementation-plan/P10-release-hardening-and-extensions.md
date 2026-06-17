# P10 - 发布加固与扩展边界

## 目标

把 P0-P9 的 MVP 打磨到可交付状态，并为 Electron、Mobile、SDK adapters、Search、External MCP 等后续能力留下清晰边界。

## 参考文件

- `README.zh-CN.md` 的“桌面应用”“移动伴随端”“已知限制”
- `openspec/specs/desktop-electron/spec.md`
- `openspec/specs/mobile-companion/spec.md`
- `openspec/specs/adapters/spec.md`
- `openspec/specs/tools/spec.md`
- `specs/12-desktop-electron.md`
- `specs/14-mobile-remote.md`
- `specs/15-external-mcp.md`
- `specs/16-message-search.md`
- `openspec/changes/stabilize-sqlite-abi-scripts/*`
- `openspec/changes/enhance-real-deployment-publishing/*`
- `openspec/changes/add-diagram-artifacts/*`

## 范围

需要完成：

- 测试补齐。
- 错误 envelope 统一。
- loading/empty/error states。
- 开发/生产启动文档。
- SDK adapter scaffold 或 follow-up docs。
- Electron/mobile 目录占位与后续计划。
- Search/deploy/MCP/diagram/PPT 等 deferred features 的明确说明。

## 测试清单

| 层级 | 测试重点 |
|---|---|
| Unit | reducer、plan compiler、path safety、tool args validation |
| Integration | DB bootstrap、message send、agent run persistence、artifact create |
| API | zod validation、settings、approval resolve、abort |
| E2E | create conversation -> send -> stream -> artifact preview |
| Manual | Windows shell/path behavior、sandbox iframe、pending approvals |

## 加固任务

1. 统一 API error response。
2. 给所有 API body 增加 zod。
3. 审核所有 `console.log`、TODO、注释代码。
4. 检查 client bundle 不 import server/native 模块。
5. 检查 `serverExternalPackages`。
6. 审核 `better-sqlite3` build/rebuild 流程。
7. 为 `.env.example` 和 README 补充运行说明。
8. 写 MVP limitations。

## Deferred Features

| Feature | 状态 |
|---|---|
| Claude Code adapter | P10 后按 `specs/05` 和 `openspec/specs/adapters` 单独实现 |
| Codex adapter | P10 后按 Codex SDK + MCP bridge 单独实现 |
| Electron | 先保持路径/构建设计，打包后续做 |
| Mobile companion | 保留 `apps/mobile` 计划，不影响 Web MVP |
| Global search | 按 `specs/16-message-search.md` 另开阶段 |
| External MCP | 按 `specs/15-external-mcp.md` 另开阶段 |
| PPT export | 按 `specs/04-artifacts.md` rich PPT 部分另开阶段 |
| Diagram artifacts | 按 `openspec/changes/add-diagram-artifacts` 另开阶段 |

## 验收标准

- `pnpm typecheck` 通过。
- `pnpm lint` 通过。
- `pnpm test` 通过。
- `pnpm build` 通过。
- README 能指导用户启动 MVP。
- MVP 手工 smoke flow 通过。
- 所有延期能力都有明确文档入口。

## 风险

- 如果在 P10 之前就引入 Electron/Mobile，会显著拖慢 MVP。
- SDK adapters 牵涉外部 runtime 和审批桥，应单独验收，不混入 Web MVP 收尾。
