# Bug #002：DeepSeek 流式工具参数重复拼接导致 JSON 解析失败

> 发现日期：2026-06-23
> 严重程度：高
> 影响范围：Custom Agent Adapter、DeepSeek 工具调用、`write_artifact`

---

## 现象

UI 设计师调用 `write_artifact` 创建较长的风格指南时，工具卡显示：

```text
Tool arguments JSON could not be parsed:
Unexpected non-whitespace character after JSON at position ...
```

另一种相关错误是：

```text
Unterminated string in JSON at position ...
```

界面能够看到 `type`、`title` 和部分 Markdown 内容，但工具调用最终失败，Artifact
没有创建。

## 根因

### 1. 流式参数被无条件追加

`custom-agent-adapter.ts` 按 OpenAI 标准增量流的方式处理
`delta.tool_calls[].function.arguments`：

```typescript
existing.args += tc.function.arguments;
```

但部分 DeepSeek/OpenAI-compatible endpoint 不总是返回纯增量片段，也可能返回：

- 当前参数的累计快照；
- 与上一帧相同的完整参数；
- 多个完整 JSON 参数对象。

当完整快照被继续追加时，结果会变成：

```text
{"type":"document", ...}
{"type":"document", ...}
```

第一个 JSON 已经结束，第二个 `{` 因而触发
`Unexpected non-whitespace character after JSON`。

### 2. 长工具参数可能达到模型输出上限

风格指南等文档会把大量 Markdown 放在工具参数中。模型达到输出上限时，参数可能停在
字符串中间：

```text
{"type":"document","content":{"content":"# Style Guide ...
```

此时缺少字符串引号和闭合括号，触发 `Unterminated string`。这类数据不能安全恢复，
否则会创建内容不完整的产物。

### 3. `content` schema 原先不够明确

`write_artifact` 的 `content` 参数原先只有描述，没有明确声明为 JSON object。
DeepSeek 有时会把以下对象再次序列化成字符串：

```json
{
  "format": "markdown",
  "content": "# Style Guide"
}
```

这会增加转义字符数量和输出长度，也提高流式参数损坏概率。

## 修复

### 1. 区分增量片段与累计快照

新增 `mergeToolArgumentChunk()`：

- 新片段以旧内容开头：视为累计快照，直接采用新内容；
- 旧内容以新片段开头：视为重复或旧快照，保留旧内容；
- 两者完全相同：不重复追加；
- 其余情况：按标准增量片段追加。

### 2. 兼容多个完整 JSON 对象

`parseToolCallArguments()` 会识别连续出现的完整 JSON object，并采用最后一个完整对象。

拆分过程会正确处理：

- 字符串内部的 `{` / `}`；
- 转义引号；
- 反斜线；
- JSON 对象之间的空白。

如果最后一个对象不完整，则仍然返回失败，不使用前面的旧快照冒充最终参数。

### 3. 明确 `write_artifact.content` 为结构化对象

工具 schema 现在要求：

```json
{
  "type": "document",
  "title": "Style Guide",
  "content": {
    "format": "markdown",
    "content": "# Style Guide"
  }
}
```

提示词明确禁止对 `content` 调用 `JSON.stringify()`。

### 4. 兼容完整的字符串化 content

如果模型仍传入完整、可解析的 JSON 字符串，`write_artifact` 会在工具边界自动解包。
无法完整解析的字符串不会被猜测性修复。

### 5. 提高 DeepSeek 单轮输出容量

Custom Agent Adapter 对 DeepSeek 请求设置 `max_tokens: 8192`。达到输出限制时，错误结果
会明确提示模型缩短内容或拆分成多个 Artifact。

## 验证

覆盖以下回归场景：

1. 标准增量工具参数；
2. 相同快照重复发送；
3. 新快照包含旧快照；
4. 多个完整 JSON 对象连续出现；
5. 完整 JSON 后跟不完整快照；
6. 工具参数因 `finish_reason = length` 被截断；
7. `content` 被完整字符串化；
8. `write_artifact` 创建 document/web_app。

相关测试与检查：

- `src/server/adapters/custom-adapter.test.ts`
- `src/server/tools/tools.test.ts`
- TypeScript、ESLint、生产构建通过

## 教训

1. OpenAI-compatible API 只代表接口形状接近，不代表流式增量语义完全一致。
2. 流式 JSON 不能简单使用字符串 `+=`；必须识别快照、重复帧和真实增量。
3. 已闭合 JSON 后出现额外内容，不应直接截取第一个对象；最后一个完整快照通常才是最新参数。
4. 不完整 JSON 不能通过自动补括号强行恢复，尤其是 Artifact 内容，可能造成静默数据损坏。
5. 工具 schema 应尽量具体，避免让模型自行猜测某个字段是 object 还是 string。

## 相关文件

- `src/server/adapters/custom-agent-adapter.ts`
- `src/server/adapters/custom-adapter.test.ts`
- `src/server/tools/write-artifact.ts`
- `src/server/tools/tools.test.ts`
- `src/server/agent-runner.ts`

