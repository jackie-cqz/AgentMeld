# P4 - AgentRunner 与 MockAdapter

## 目标

先不依赖真实 LLM，使用 MockAdapter 跑通 AgentRun 生命周期和流式消息链路。这是后续 Custom/Claude/Codex adapter 的基础验收线。

## 参考文件

- `openspec/specs/adapters/spec.md`
- `openspec/specs/stream-events/spec.md`
- `openspec/specs/conversation-context/spec.md`
- `specs/02-stream-events.md`
- `specs/05-adapter-interface.md`
- `specs/13-conversation-context.md`
- `skills/add-adapter.md`
- `AGENT_BACKEND.md` 第 1、2、3、15 章

## 范围

需要实现：

- `src/server/agent-runner.ts`
- `src/server/adapters/types.ts`
- `src/server/adapters/registry.ts`
- `src/server/adapters/mock-adapter.ts`
- `src/app/api/runs/[id]/abort/route.ts`

## 生命周期

Adapter 只发：

```text
message.start
  part.start
  part.delta*
  part.end
  tool.call?
  tool.result?
  artifact.create?
message.end
run.usage?
```

AgentRunner 负责：

```text
run.start
consume adapter events
persist events
publish events
run.end
```

## 任务拆分

1. 定义 `AgentPlatformAdapter` 和 `AdapterInput`。
2. 实现 adapter registry。
3. 实现 active run abort map。
4. `AgentRunner.run()` 创建 `agent_runs` 记录。
5. `executeRun()` 读取 agent/conversation/workspace。
6. `buildAdapterInput()` 拼接 prompt 和基础上下文。
7. 消费 adapter stream，持久化并 publish。
8. MockAdapter 模拟文本、工具、artifact 事件。
9. 失败时创建可见错误消息。

## 验收标准

- 给 Mock agent 发消息会创建 run。
- UI 能看到流式文本。
- run 最终状态为 `complete`。
- MockAdapter 能产生至少一个 tool call/result。
- abort API 能中止运行。
- Adapter 不直接写 DB、不直接推 SSE。

## 风险

- Spec 05 中记录过 AdapterInput 与代码漂移，实际实现时要以最新共享类型为准，并同步 spec。
- run 失败时未闭合的 tool call 必须有可见错误结果。
