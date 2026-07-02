# P10 - Mobile、External MCP 与发布收尾

## 对应 specs

- `specs/14-mobile-remote.md`
- `specs/15-external-mcp.md`
- `specs/16-message-search.md`
- `specs/12-desktop-electron.md`

## 当前问题

当前这些能力基本没有代码实现：

- 没有 `apps/mobile`。
- 没有 pairing/device session。
- 没有 `/api/mobile/*`。
- 没有 companion mode 监听地址门控。
- 没有外部 MCP server 数据模型。
- 没有 MCP 配置 UI。
- 没有 external MCP 接线到 claude-code/codex/custom。
- 搜索也还未实现，若 P7 未完成，P10 前必须先补。

## 需要做的内容

### Mobile companion

1. 项目结构。
   - 新增 `apps/mobile` Capacitor + React/Vite app。
   - 可选抽 `packages/shared` 共享类型/API DTO/reducer helper。

2. Companion mode。
   - app_settings 支持 companion mode。
   - 桌面端默认 off。
   - 开启后监听 LAN/tailnet 地址。
   - 远程访问必须鉴权。

3. Pairing。
   - device_sessions 表。
   - pairing code。
   - `POST /api/mobile/pair`。
   - device token 管理。

4. Mobile API。
   - `GET /api/mobile/snapshot`。
   - `GET /api/mobile/conversations/:id`。
   - `GET /api/mobile/events`。
   - `POST /api/mobile/conversations/:id/messages`。
   - `POST /api/mobile/runs/:id/abort`。
   - pending write/question approve/reject/answer。
   - artifact safe preview/export。

5. Mobile UI。
   - 会话列表。
   - 消息流。
   - running run 状态。
   - Conductor plan 状态。
   - fs_write approval。
   - ask_user answer。
   - artifact lightweight preview。

### External MCP

1. 数据模型。
   - mcp_servers 全局定义。
   - agent_mcp_servers 关联。
   - headers/env 脱敏。

2. Settings UI。
   - 新增/编辑/删除 MCP server。
   - test connection。
   - 显示 command/args/env/security warning。
   - Agent Builder 中 opt-in server。

3. Adapter 接线。
   - ClaudeCode/Codex 先接外部 MCP server。
   - Custom adapter 后续新建 MCP client 层。
   - 工具命名统一 `mcp__server__tool`。
   - tool.call/tool.result 复用现有事件。

4. 安全。
   - 默认不启用。
   - 每个 agent 手动 opt-in。
   - per-tool-per-conversation 首次调用审批。
   - abort 时关闭 MCP 连接和 stdio 进程。
   - 明确标注外部 MCP 不受 AgentMeld sandbox 保证。

### Release hardening

1. README 与实际能力一致。
2. MVP limitations。
3. 手工 smoke flow。
4. CI 或本地 scripts 明确 typecheck/lint/test/build。
5. 示例 `.env.example`。
6. 清理 specs 中过期“已实现”状态。

## 验收标准

- Mobile app 可配对桌面端。
- Mobile 可查看会话和 pending approval。
- Mobile approval 能驱动桌面端 pending queue 继续。
- 未鉴权设备不能访问 mobile API。
- 用户可配置一个外部 MCP server 并给 agent opt-in。
- 外部 MCP 工具调用显示为 tool.call/tool.result。
- 外部 MCP 首次调用需要审批。
- README 的功能状态与代码一致。

## 不在本优先级范围

- 不在手机上运行 LLM、SQLite、bash 或 workspace。
- 不做 OAuth-flow 远程 MCP。
- 不做 MCP server 托管。
- 不做 auto-update。

