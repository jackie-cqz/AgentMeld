# Skill：新增一个工具

> **目的**:给 Agent 加一个内置工具(LLM 可调用的 function),如 `read_artifact`、`fs_write`、`bash`。
> **契约文档**:`specs/07-tools.md`。
> *行号基线:commit `b60c4f8`。对不上时按符号名搜索。*

---

## 何时用 / 何时不用

- ✅ 想让 Agent 具备一种新的「动作」(读写某资源、调外部能力、向用户提问)。
- ❌ 想改某个工具的行为 / 参数——直接改那个工具文件 + 同步 spec 07,不用走「新增」。
- ❌ Claude Code agent 想要的能力 SDK 已自带(它走 SDK 预置工具,不读本项目工具表,见 §坑 5)。

---

## 前置阅读

1. `specs/07-tools.md` —— 工具清单、签名约定、命名规则、错误契约。
2. `src/server/tools/types.ts` —— `ToolDef` / `ToolContext` / `ToolResult`。
3. `src/server/tools/read-artifact.ts` —— **最简模板**(纯读、zod 校验、按会话 scope)。
4. `src/server/tools/registry.ts` —— 注册 + `execute`(事实上的 ToolExecutor)。

---

## 你要满足的契约

`ToolDef`(`src/server/tools/types.ts:19-25`):

```ts
export interface ToolDef {
  name: string
  description: string
  /** JSON Schema —— 同时给 LLM 的 tool 声明和我们自己的运行时校验 */
  parameters: Record<string, unknown>
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>
}
```

`ToolContext`(`types.ts:7-13`):`conversationId` / `workspacePath` / `agentId` / `runId` / `abortSignal`。
`ToolResult`(`types.ts:15-17`):`{ ok: true; value: unknown } | { ok: false; error: string }`。

要点:
- **name** 必须 `^[a-zA-Z0-9_]+$`(snake_case,无点无连字符)——它要当 LLM 可调用标识符(spec 07:42)。
- **input schema 写两遍**:`parameters` 是手写 **JSON Schema**(给 LLM 看),运行时另用一个 **zod schema**(`safeParse`)。两者**不自动同步,手工保持一致**。
- **handler 收原始 `unknown`**(LLM 生成的,可能不合规),必须先 `safeParse`;**返回 `ToolResult` 对象,不是 `StreamEvent`**(adapter 负责把它包成 `tool.result` 事件)。

---

## 步骤

以新增 `my_tool` 为例。

### 1. 新建工具文件(抄 `read-artifact.ts`)

新建 `src/server/tools/my-tool.ts`:

```ts
import { z } from 'zod'
import type { ToolDef } from './types'

const ArgsSchema = z.object({
  target: z.string().min(1),
})

export const myTool: ToolDef = {
  name: 'my_tool',
  description: '一句话讲清「什么时候该调它」——这是 LLM 选用的主要信号。',
  parameters: {
    type: 'object',
    required: ['target'],
    properties: {
      target: { type: 'string', description: '……' },
    },
  },
  async handler(args, ctx) {
    const parsed = ArgsSchema.safeParse(args)
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` }
    }
    // … 干活;按 ctx.conversationId scope;业务失败 return {ok:false,error} …
    return { ok: true, value: { /* 给 LLM 看的结果 */ } }
  },
}
```

模板对照 `read-artifact.ts`:zod 在模块顶(`:8-10`)、`parameters` JSON Schema(`:15-21`)、handler 里先 `safeParse`(`:22-26`)、按 `ctx.conversationId` 过滤(`:31`)、业务错 `return {ok:false}`(`:34-36`)、成功 `return {ok:true,value}`(`:38-47`)。带副作用 + 可选字段的看 `write-artifact.ts`;用沙箱的看 `fs-read.ts`。

### 2. 在 registry 注册

`src/server/tools/registry.ts`,`buildRegistry()`(`:58-69`):

```ts
import { myTool } from './my-tool'   // 加进顶部 import 块(字母序,约 L1-9)

function buildRegistry(): ToolRegistry {
  const reg = new ToolRegistry()
  reg.register(writeArtifactTool)
  // … 其余 …
  reg.register(myTool)               // ← 加这行(L60-67 区块内)
  return reg
}
```

`register` 遇重名抛错(`:21-26`);singleton 在 `:73`。registry 每次加载重建(无 `globalThis` HMR 缓存,`:71-73`),所以 dev 下加工具**不用重启**即生效。

### 3. 让 UI 能勾选

`src/components/create-agent-dialog.tsx:38` 的 `AVAILABLE_TOOLS` 元组——把 `'my_tool'` 加进去,创建/编辑 Agent 弹窗才会出现这个勾选框。

> 已存在的 DB Agent **不会自动获得**新工具;用户要在「编辑 Agent」里重新勾选(第 3 步就是让这个勾选框出现)。

### 4.(可选)内置 Agent 默认带

`src/db/builtin-agents.ts` 各 agent 的 `toolNames` 数组(`:24/48/73/98/121`)——只在「想让某内置 agent 出厂自带」时加;且只影响**全新 seed**,不改已有库。

### 5. 同步 spec 07

`specs/07-tools.md`:内置工具清单表(`:69-77`)加一行 + 写一节 `### my_tool`。

---

## 工具是怎么到达 LLM 的(理解用,通常不用改)

`CustomAgentAdapter` 负责把 registry 变成 LLM 工具表:
1. `toolRegistry.resolve(input.toolNames)`(`custom-agent-adapter.ts:53`)按 agent 配置取工具,未知名直接抛。
2. `.map(toApiTool)`(`:54`)→ `toApiTool`(`:378-391`)把 `ToolDef.parameters` 原样塞进 OpenAI 的 `function.parameters`。
3. `tools: apiTools`(`:116`)传给模型。
4. 模型回调时:发 `tool.call` 事件 → `toolRegistry.execute(name, args, ctx)`(`:270`)→ 发 `tool.result`(`result: value, isError: !ok`,`:273-279`)。`execute`(`registry.ts:42-55`)是事实上的 ToolExecutor,会把 handler 抛出的异常兜成 `{ok:false,error}`。

---

## 常见坑

1. **沙箱:碰文件系统的工具(fs_*/bash)绝不能直接用 `ctx.workspacePath`**。每个路径参数过 `assertPathWithinWorkspace(workspace, target)`(`src/server/workspace-utils.ts:47-53`)→ 内部 `resolveSafePath`(`:40-45`)以 `getEffectiveCwd(workspace)` 解析相对路径,逃出子树就抛 `Path "..." is outside workspace`。先 `getWorkspaceForConversation(ctx.conversationId)` 拿 workspace(`fs-read.ts:37-38`)。bash 的 cwd 强制为 `getEffectiveCwd`。(effective cwd = local 模式 `boundPath`,sandbox 模式 `rootPath`,`workspace-utils.ts:10-16`。)spec 07:147、292-301。

2. **业务错误 `return {ok:false,error}`,不要 `throw`**(spec 07:251)。`throw` 只留给「真正意外的内部异常」,registry 会兜住它。错误串会作为 `tool_result.isError=true` 喂给 LLM,所以要写人/模型都能懂的原因(CLAUDE.md §4.4:异常要有上下文)。

3. **两个 schema 手工对齐**:`parameters`(JSON Schema)和 zod `ArgsSchema` 各写一份,改一个记得改另一个。JSON Schema 建议 `type:'object'`(别用 `oneOf`,DeepSeek/OpenAI 兼容性差)、列全 `required`、`description` 写具体(spec 07:284-287)。

4. **按会话 scope**:碰 DB / 文件的工具要用 `ctx.conversationId` 限定,防跨会话越权(`read-artifact.ts:31`、`write-artifact.ts:78-80`)。

5. **Claude Code 走的是另一条路**:`claude-code-adapter.ts` 里那些 agent **不读本项目工具表**,用 SDK 预置工具;只有 `write_artifact`/`read_artifact`/`ask_user` 被按名桥接进 SDK MCP 层(`:134/153/193`),由 `canUseTool` 钩子(`:231`)放行。普通新工具只需管好 Custom 这条路(spec 07:313-325)。

6. **`value.artifactId` 约定**:若 handler 成功 `value` 里含字符串 `artifactId`,Custom adapter 自动发 `artifact.create`、Runner 注入 `artifact_ref` part(`custom-agent-adapter.ts:281-289`、`write-artifact.ts:18-21`)。别自己发那个事件。

7. **黑名单是单一数据源**:若新工具引入要禁的 shell 命令,规则只写 `src/server/security.ts` 的 `getBannedPatterns`,并同步 spec 11(CLAUDE.md §5.2)。

---

## 提交自检(对齐 CLAUDE.md §6.5)

- [ ] `pnpm typecheck` / `pnpm lint` 过
- [ ] handler 入参先 `safeParse`,业务错走 `{ok:false,error}` 而非 throw
- [ ] `parameters`(JSON Schema)与 zod schema 一致
- [ ] 碰 fs/bash 的:路径全过 `assertPathWithinWorkspace`,cwd 为 effective cwd
- [ ] 长操作尊重 `ctx.abortSignal`
- [ ] registry 注册了;UI `AVAILABLE_TOOLS` 加了(若需用户可勾)
- [ ] `specs/07` 已同步;引入禁用命令的同步了 `security.ts` + spec 11
