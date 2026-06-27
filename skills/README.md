# AgentMeld Skills

> 面向 Claude Code 和 AI 协作工具的项目参考文档。

| Skill | 内容 |
|-------|------|
| [add-tool.md](add-tool.md) | 工具系统：12 个工具一览、新增步骤、审批流程、Conductor 编排 |
| [artifacts.md](artifacts.md) | 产物系统：4 种类型、生命周期、版本链、部署、Conductor 产出绑定 |
| [context.md](context.md) | 上下文管理：Token 预算、增量压缩、Pinned、滚动摘要、并发锁 |
| [persistence.md](persistence.md) | 持久化系统：表结构、迁移、启动恢复、审批持久化 |

## 项目结构速查

```
src/
├── server/
│   ├── tools/            ← 12 个工具定义
│   │   ├── registry.ts   ← ToolRegistry
│   │   └── types.ts      ← ToolDef / ToolContext
│   ├── adapters/         ← LLM 平台适配器
│   ├── repositories.ts   ← DB CRUD
│   ├── conversation-context.ts  ← 历史构建 + 压缩
│   ├── context-compaction-service.ts ← 压缩窗口 + 分块
│   ├── orchestrator-service.ts ← DAG 调度 + Recovery
│   ├── dispatch-plan.ts  ← Plan 编译 + 校验
│   ├── run-recovery.ts   ← 启动恢复
│   └── settings-service.ts ← API Key 三层优先级
├── db/
│   ├── bootstrap.ts      ← 建表 + 迁移
│   └── rows.ts           ← 实体映射
├── stores/               ← Zustand 状态管理
├── components/           ← React UI 组件
└── shared/
    ├── types.ts          ← 核心类型定义
    └── agent-constants.ts ← 工具预设
```
