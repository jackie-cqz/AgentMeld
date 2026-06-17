# P2 - EventBus 与 SSE

## 目标

实现系统的实时事件骨架。所有 agent 输出、工具活动、产物、审批和调度状态都必须先变成 `StreamEvent`，再通过 EventBus 和 SSE 到达前端。

## 参考文件

- `openspec/specs/stream-events/spec.md`
- `openspec/specs/frontend/spec.md`
- `specs/02-stream-events.md`
- `specs/09-frontend-architecture.md`
- `AGENT_BACKEND.md` 第 15.1、15.2 节
- `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`

## 范围

需要实现：

- `src/server/event-bus.ts`
- `src/app/api/stream/route.ts`
- `src/stores/app-store.ts`
- `src/components/stream-provider.tsx`
- `StreamEvent` 完整类型

## 事件分组

| 分组 | 事件 |
|---|---|
| run | `run.start`、`run.end`、`run.usage` |
| message | `message.added`、`message.removed`、`message.start`、`message.end`、`message.usage` |
| part | `part.start`、`part.delta`、`part.end` |
| tool | `tool.call`、`tool.result` |
| artifact | `artifact.create`、`artifact.update` |
| approval | `fs_write.pending/resolved`、`bash_command.pending/resolved` |
| dispatch | `dispatch.plan.*`、`dispatch.task.*` |
| transport | `heartbeat` |

## 任务拆分

1. 实现 HMR 安全的 `globalThis` EventBus 单例。
2. 定义 subscribe/publish API。
3. 实现 SSE route，返回 `text/event-stream`。
4. 增加 heartbeat，避免连接静默断开。
5. 前端建立单一 EventSource。
6. Zustand store 实现 `applyEvent(event)`。
7. 为 `message.added` 和 `message.removed` 做幂等 upsert/remove。

## 验收标准

- 打开页面后只有一个 SSE 连接。
- 服务器发布 heartbeat，前端能收到。
- 手动发布测试事件能更新 store。
- EventSource 断线后可重连。
- 删除/新增消息事件重复到达不会产生重复状态。

## 风险

- Route Handler 的 GET 默认可能被静态化；SSE route 必须保持动态。
- 高频 `part.delta` 可能导致过多 DB 写入，P4/P6 需要关注批处理或边界。
