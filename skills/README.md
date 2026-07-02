# skills/ —— 可复用开发任务模板

> `specs/` 定**规格**(要做什么)、`CLAUDE.md` 定**规则**(怎么做 / 不做什么)、`OVERVIEW.md` 定**地图**(做了什么 / 代码在哪)。
> 本目录定**配方**:几类「会反复做」的扩展任务,各给一份步骤化指南,让任何 AI 协作工具(Claude Code / Cursor / Codex …)或新同学不通读全库就能照着加。

每份指南遵循同一骨架:**何时用 → 前置阅读 → 你要满足的契约 → 编号步骤(附 file:line + 抄哪个现成例子)→ 常见坑 → 提交自检**。

| Skill | 何时用 | 对应 spec |
|---|---|---|
| [新增一个 Adapter](add-adapter.md) | 接入一个新的 agent 平台(如 Codex / OpenCode) | `specs/05` |
| [新增一个工具](add-tool.md) | 给 Agent 加一个内置工具(LLM 可调用的 function) | `specs/07` |
| [新增一种 MessagePart 类型](add-message-part.md) | 消息里要渲染一种新内容块(且 markdown 表达不了) | `specs/03`(+ `02`) |
| [新增一种 Artifact 类型](add-artifact-type.md) | 产物面板要支持一种新产物(如激活 diff、新增图表) | `specs/04` |

> ⚠️ **行号会随代码漂移**。每份指南里的 `file:line` 是写作时(基线 commit 见各文件)的快照;若对不上,**以文中的符号名 / 函数名为准**搜索定位。指南与代码冲突时,按 `CLAUDE.md §9`「以 spec 为准,先改对一边并写明」。
