# Skill：新增一个 Adapter

> **目的**:接入一个新的 agent 平台(如 Codex、OpenCode、Gemini CLI),让它能像 ClaudeCode / CustomAgent 一样被 Agent 选用。
> **契约文档**:`specs/05-adapter-interface.md`。本指南是它的「落地配方」,并修正了 spec 与真实代码已漂移的几处(见 §坑 2)。
> *行号基线:commit `b60c4f8`。对不上时按符号名搜索。*

---

## 何时用 / 何时不用

- ✅ 要接一个**真正的 agent 平台**(自带 agentic 循环、工具、session 的 CLI/SDK)。
- ❌ 只是想换一个**模型 provider**(DeepSeek / OpenAI / 火山方舟 等 OpenAI 兼容端点)——那走 `CustomAgentAdapter` 配置即可,**不要**新建 adapter。判断标准:对方是「会自己调工具、写文件的 agent」还是「一个 chat completions 端点」。

---

## 前置阅读

1. `specs/05-adapter-interface.md` —— 接口契约、事件翻译职责、Abort 约定。
2. `src/server/adapters/types.ts` —— `AgentPlatformAdapter` 接口 + `AdapterInput`(**以此为准**,不是 spec 里的)。
3. `src/server/adapters/mock-adapter.ts` —— 最干净的骨架,新 adapter 照它抄。
4. `src/server/adapters/custom-agent-adapter.ts` —— 真实 tool-loop 参考(流式解析 + 工具执行 + usage 上报)。

---

## 你要满足的契约

整个接口只有 **2 个成员**(`src/server/adapters/types.ts:11-15`):

```ts
export interface AgentPlatformAdapter {
  readonly name: AdapterName
  stream(input: AdapterInput, signal: AbortSignal): AsyncIterable<StreamEvent>
}
```

`stream` 是个 async generator,**只管把平台的输出翻译成 `StreamEvent` 并 `yield`**。它的事件生命周期必须是:

```
message.start
  → (part.start → part.delta* → part.end)*      // 文本 / thinking / code
  → (tool.call → tool.result)*                   // 工具调用
  → [run.usage]                                  // 可选,上报 token
message.end
```

> `run.start` / `run.end` **不归 adapter**,由 `AgentRunner` 在 adapter 外发(`agent-runner.ts` 起止)。adapter 只发 `message.*` / `part.*` / `tool.*` / `run.usage` / `artifact.create`。

**铁律(CLAUDE.md §3.1)**:adapter **永不写 DB、永不推 SSE、不跨调用持有状态**(SDK client 除外)。它只翻译事件;「事件 → 持久化 + 广播」唯一归 `AgentRunner`。

`AdapterInput` 里你能读到的关键字段(`types.ts:17-65`):`prompt`(已拼好的完整提示)、`systemPrompt`(已注入 `<workspace_info>`)、`workspacePath`、`apiKey` / `apiBaseUrl` / `modelId`、`toolNames`、`attachments?`、`history?`、`customConfig?`(仅 custom 用)。

---

## 步骤

以新增 `CodexAdapter` 为例。

### 1. 确认 / 扩展 `AdapterName` 联合

`src/shared/types.ts:79`:

```ts
export type AdapterName = 'claude-code' | 'codex' | 'custom' | 'mock'
```

> ⚠️ **`'codex'` 已经在联合里**了(历史预留)。这意味着 `agent.adapterName = 'codex'` 能通过类型检查,但 `registry.getAdapter` 在运行时会抛 `No adapter registered for "codex"`。所以接 Codex **不用动这一行**;接一个全新名字(如 `'opencode'`)才需要在这里加。

### 2. 新建 adapter 文件,抄 MockAdapter 骨架

新建 `src/server/adapters/codex-adapter.ts`:

```ts
export class CodexAdapter implements AgentPlatformAdapter {
  readonly name = 'codex' as const

  async *stream(input: AdapterInput, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const messageId = newMessageId()
    yield { type: 'message.start', conversationId: input.conversationId, messageId, timestamp: Date.now() }
    // … 把平台输出翻译成 part.*/tool.* 事件 yield 出去 …
    yield { type: 'message.end', conversationId: input.conversationId, messageId, timestamp: Date.now() }
  }
}
```

抄 `mock-adapter.ts:19-159` 的整体结构;每个事件都要带 `conversationId` + `timestamp`(`BaseEvent`,`shared/types.ts:156-159`)。如果是「读子进程行分隔 JSON」(spec 05:413-423 的 `spawn('codex', ['--json'])` 草图),写一个 `行 → StreamEvent` 的翻译循环即可。需要真 LLM tool-loop 就改抄 `custom-agent-adapter.ts`(注意它的 `baseEvent(input, body)` 助手,`:423-432`)。

### 3. 在 registry 注册

`src/server/adapters/registry.ts`:

```ts
import { CodexAdapter } from './codex-adapter'   // 加在其它 import 旁(约 L4-6)

function buildRegistry(): AgentRegistry {
  const reg = new AgentRegistry()
  reg.register(new MockAdapter())
  reg.register(new CustomAgentAdapter())
  reg.register(new ClaudeCodeAdapter())
  reg.register(new CodexAdapter())   // ← 替换掉这里原来的 `// TODO CodexAdapter` (L37)
  return reg
}
```

`register` 按 `adapter.name` 入 `Map`(`:17-19`);`getAdapter` 按 `agent.adapterName` 取,取不到就抛(`:21-29`)——这就是为什么第 1 步的类型存在 ≠ 运行时可用。

### 4. 放开创建入口的 zod enum(否则 API 拒绝)

`src/app/api/agents/route.ts:18` 的创建校验只认两种:

```ts
adapterName: z.enum(['custom', 'claude-code'])   // → 加 'codex'
```

不加这里,前端建不出 codex agent(400)。若 Codex 有必填字段(provider / model),同步:
- `route.ts:26-29` 的 `.refine`
- `src/server/agent-service.ts:37-43` 的 per-adapter 校验分支

### 5.(可选)`buildAdapterInput` 的 per-agent 分支

`AgentRunner` 选 adapter 是**泛型**的(按 `adapterName`),无需改。但 `buildAdapterInput` 目前只为 `'custom'`/`'claude-code'` 填 key 兜底 / `customConfig`(`agent-runner.ts:1008`、`:1071-1077`、`:1086-1098`)。Codex 若要 per-agent key 兜底或类似 config,在这里加 `=== 'codex'` 分支。

### 6.(可选)UI 与内置 Agent

- `src/components/create-agent-dialog.tsx:27` 的本地 `AdapterKind` 联合 + 单选块(约 `:273-280`)——想在创建弹窗里能选 Codex 才需要改。
- `src/db/builtin-agents.ts`——想随项目种一个内置 Codex agent 才加。

### 7. 同步 spec

`specs/05-adapter-interface.md`:状态表(`:11-16`)、CodexAdapter 节(`:413-423`)、新增步骤清单(`:455-464`)改成「已实现」。

---

## 常见坑

1. **AbortSignal 必须贯穿每一次 LLM 调用**(CLAUDE.md §4.4)。
   - 生成器里每步前查 `if (signal.aborted) return`(`mock-adapter.ts:39`、`custom-agent-adapter.ts:92`)。
   - 把 signal 透传进网络调用:`client.chat.completions.create({...}, { signal })`(`custom-agent-adapter.ts:120`)。
   - SDK 不收 `AbortSignal` 的,建内层 `AbortController` 并 `signal.addEventListener('abort', () => c.abort(), { once: true })`(spec 05:392-399)。
   - 中止时静默 `return`,由 AgentRunner 判 run 为 `aborted`。

2. **不要信 spec 05 里的 `AdapterInput` 代码块**——它已漂移(列了 `parentRunId`、`customConfig.modelId/apiKey/systemPrompt` 等真实代码没有的字段)。`systemPrompt`/`apiKey`/`apiBaseUrl`/`modelId` 在真实 `types.ts` 里是**根字段**,`customConfig` 只有 `modelProvider` + `supportsVision?`。**以 `types.ts` 为准**;顺手把 spec 改对(CLAUDE.md §9)。

3. **类型存在 ≠ 运行可用**:`'codex'` 在 4 个地方各自为政——`AdapterName` 联合(有)、registry 注册(无)、API enum(无)、UI(无)。少接一处就在那一层断。接新平台时把 §1–§6 逐条过一遍。

4. **工具执行不归 adapter**(CLAUDE.md §3.1)。要跑工具就 `toolRegistry.execute(name, args, ctx)`(`custom-agent-adapter.ts:270`),`ctx.abortSignal = signal`。工具 arg 解析失败要变成 `tool.result.isError=true`,不是 adapter 抛错。

5. **`value.artifactId` 约定**:若工具结果里带 `artifactId`,Custom adapter 会自动补发 `artifact.create`、AgentRunner 注入 `artifact_ref` part(`custom-agent-adapter.ts:281-289`)。**别自己再发** `artifact.create`。

---

## 提交自检(对齐 CLAUDE.md §6.5)

- [ ] `pnpm typecheck` / `pnpm lint` 过
- [ ] 新 adapter 的 `stream` 严格遵守 `message.start → … → message.end` 生命周期,每个事件带 `conversationId`+`timestamp`
- [ ] 每个 LLM/网络调用都收了 `AbortSignal`,中止能静默退出
- [ ] adapter 没碰 DB / 没推 SSE
- [ ] `AdapterName` / registry / API enum / (UI) 四处一致,选它不会运行时抛错
- [ ] `specs/05` 已同步;若顺手修了 spec 的漂移,在 commit 里说明
