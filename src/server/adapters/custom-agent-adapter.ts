import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type { AdapterName, DeployStatusRecord } from "@/shared/types";
import type { AgentPlatformAdapter, AdapterInput } from "@/server/adapters/types";
import { toolRegistry } from "@/server/tools/registry";
import type { ToolContext } from "@/server/tools/types";
import { getSettings, resolveApiKey } from "@/server/settings-service";
import { getArtifact } from "@/server/repositories";
import { getTaskReport, recordTaskArtifact } from "@/server/dispatch-task-results";
import { buildPromptLayout } from "@/server/prompt-layout/prompt-layout-builder";

export const CUSTOM_AGENT_MAX_TOOL_ROUNDS = 48;
export const TASK_REPORT_FINALIZATION_ROUNDS = 1;

export function shouldFinalizeTaskReport(input: AdapterInput, hasReport: boolean): boolean {
  return input.toolNames.includes("report_task_result") && !hasReport;
}

type ToolArgumentFaultInterceptor = (input: {
  runId: string;
  toolName: string;
  rawArguments: string;
}) => string | null;

let toolArgumentFaultInterceptor: ToolArgumentFaultInterceptor | null = null;

export function setToolArgumentFaultInterceptorForTests(interceptor: ToolArgumentFaultInterceptor | null): void {
  if (interceptor && process.env.AGENTMELD_BENCH_FAULT_INJECTION !== "1") {
    throw new Error("Tool argument fault injection is only available to the benchmark runtime.");
  }
  toolArgumentFaultInterceptor = interceptor;
}

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  "volcano-ark": "https://ark.cn-beijing.volces.com/api/v3"
};

function buildClient(agent: AdapterInput["agent"]): OpenAI {
  const provider = agent.modelProvider ?? "openai";
  const settings = getSettings();
  const apiKey = resolveApiKey(provider, agent.apiKey, settings);

  if (!apiKey) {
    throw new Error(
      `No API key configured for provider "${provider}". ` +
      `Set it in Settings, on the agent, or via the ${provider.toUpperCase()}_API_KEY environment variable.`
    );
  }

  const baseURL = agent.apiBaseUrl || PROVIDER_BASE_URLS[provider];

  return new OpenAI({
    apiKey,
    baseURL: baseURL || undefined
  });
}

export const customAgentAdapter: AgentPlatformAdapter = {
  name: "custom" as AdapterName,

  async *run(input: AdapterInput, signal: AbortSignal) {
    const conversationId = input.conversationId;
    let client: OpenAI;
    try {
      client = buildClient(input.agent);
    } catch (error) {
      // Yield a text error part
      yield {
        type: "part.start",
        conversationId,
        timestamp: Date.now(),
        messageId: "",
        partIndex: 0,
        part: {
          type: "text",
          content: `⚠️ ${error instanceof Error ? error.message : "Failed to build API client."}`
        }
      };
      yield {
        type: "run.usage",
        conversationId,
        timestamp: Date.now(),
        runId: "",
        usage: { modelId: input.agent.modelId ?? "unknown", inputTokens: 0, outputTokens: 0 }
      };
      return;
    }

    const model = input.agent.modelId || "gpt-4.1-mini";
    const provider = input.agent.modelProvider ?? "openai";

    const tools = buildChatCompletionTools(input);

    // Build messages
    const messages = buildMessages(input);

    // Tool loop
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let partIndex = 0;
    let deployToolSucceededInRun = false;
    let reportToolSucceededInRun = false;

    let currentMessages = [...messages];
    let exhaustedToolRounds = false;
    let finalizationMode = false;
    for (
      let round = 0;
      round < CUSTOM_AGENT_MAX_TOOL_ROUNDS + TASK_REPORT_FINALIZATION_ROUNDS;
      round++
    ) {
      if (signal.aborted) break;

      const isFinalizationRound = finalizationMode || round >= CUSTOM_AGENT_MAX_TOOL_ROUNDS;
      if (isFinalizationRound) {
        if (!shouldFinalizeTaskReport(input, Boolean(getTaskReport(input.runId)))) {
          break;
        }
        if (!finalizationMode) {
          finalizationMode = true;
        }
        currentMessages = [
          ...currentMessages,
          {
            role: "system",
            content:
              "工作轮次已经结束。不要再读取、修改、构建或部署任何内容。" +
              "现在必须基于已有工具结果调用 report_task_result 一次，真实汇报完成状态、验收结果、产物、文件、命令和测试证据。" +
              "不得输出普通文本，不得调用其他工具。"
          }
        ];
      }

      const roundTools = isFinalizationRound
        ? buildChatCompletionTools({ ...input, toolNames: ["report_task_result"] })
        : tools;
      let stream: Awaited<ReturnType<typeof client.chat.completions.create>>;
      try {
        stream = await client.chat.completions.create({
          model,
          messages: currentMessages,
          tools: roundTools.length > 0 ? roundTools : undefined,
          tool_choice: isFinalizationRound
            ? { type: "function", function: { name: "report_task_result" } }
            : undefined,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: provider === "deepseek" ? 8192 : undefined
        });
      } catch (err: unknown) {
        const errorText = formatApiError(err, model);
        if (round === 0) {
          // First round error — show directly as message part
          yield { type: "part.start", conversationId, timestamp: Date.now(), messageId: "", partIndex, part: { type: "text", content: "" } };
          yield { type: "part.delta", conversationId, timestamp: Date.now(), messageId: "", partIndex, delta: { type: "text.append", text: errorText } };
          yield { type: "part.end", conversationId, timestamp: Date.now(), messageId: "", partIndex };
        }
        yield { type: "run.usage", conversationId, timestamp: Date.now(), runId: "", usage: { modelId: model, inputTokens: totalInputTokens, outputTokens: totalOutputTokens } };
        return;
      }

      // Accumulate deltas
      let textContent = "";
      const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
      let hasToolCalls = false;
      let finishReason: string | null = null;
      let textPartStarted = false;
      let thinkingPartStarted = false;
      const currentTextPartIndex = partIndex;
      const currentThinkingPartIndex = thinkingPartStarted ? partIndex + (textPartStarted ? 1 : 0) : -1;

      for await (const chunk of stream) {
        if (signal.aborted) break;

        // Track usage
        if (chunk.usage) {
          totalInputTokens += chunk.usage.prompt_tokens || 0;
          totalOutputTokens += chunk.usage.completion_tokens || 0;
        }

        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (!delta) continue;

        // Text content
        if (delta.content) {
          if (!textPartStarted) {
            textPartStarted = true;
            yield {
              type: "part.start",
              conversationId,
              timestamp: Date.now(),
              messageId: "",
              partIndex: currentTextPartIndex,
              part: { type: "text", content: "" }
            };
          }
          textContent += delta.content;
          yield {
            type: "part.delta",
            conversationId,
            timestamp: Date.now(),
            messageId: "",
            partIndex: currentTextPartIndex,
            delta: { type: "text.append", text: delta.content }
          };
        }

        // Reasoning / thinking (DeepSeek)
        const reasoning = (delta as Record<string, unknown>).reasoning_content as string | undefined;
        if (reasoning) {
          if (!thinkingPartStarted) {
            thinkingPartStarted = true;
            const thinkingIdx = textPartStarted ? currentTextPartIndex + 1 : currentTextPartIndex;
            yield {
              type: "part.start",
              conversationId,
              timestamp: Date.now(),
              messageId: "",
              partIndex: thinkingIdx,
              part: { type: "thinking", content: "" }
            };
          }
          yield {
            type: "part.delta",
            conversationId,
            timestamp: Date.now(),
            messageId: "",
            partIndex: currentThinkingPartIndex >= 0 ? currentThinkingPartIndex : (textPartStarted ? currentTextPartIndex + 1 : currentTextPartIndex),
            delta: { type: "thinking.append", text: reasoning }
          };
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index;
            if (!toolCalls.has(index)) {
              toolCalls.set(index, {
                id: tc.id || "",
                name: tc.function?.name || "",
                args: tc.function?.arguments || ""
              });
            } else {
              const existing = toolCalls.get(index)!;
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) {
                existing.args = mergeToolArgumentChunk(
                  existing.args,
                  tc.function.arguments
                );
              }
            }
          }
          hasToolCalls = true;
        }
      }

      // End text/thinking parts
      if (textPartStarted) {
        yield { type: "part.end", conversationId, timestamp: Date.now(), messageId: "", partIndex: currentTextPartIndex };
        partIndex = currentTextPartIndex + 1;
      }
      if (thinkingPartStarted) {
        const ti = textPartStarted ? currentTextPartIndex + 1 : currentTextPartIndex;
        yield { type: "part.end", conversationId, timestamp: Date.now(), messageId: "", partIndex: ti };
        partIndex = ti + 1;
      }

      if (signal.aborted) break;

      // If no tool calls, we're done
      if (!hasToolCalls || toolCalls.size === 0) {
        if (isFinalizationRound) {
          exhaustedToolRounds = true;
          break;
        }
        const ctx = buildToolContext(input, signal);
        const deployPath = findDeployableWorkspacePath(ctx.workspacePath);
        if (shouldAutoDeployWorkspace(textContent, input.toolNames, deployToolSucceededInRun, input.taskContract, deployPath)) {
          if (deployPath) {
            const outputKey = inferSingleWebAppOutputKey(input.taskContract);
            const args = {
              path: deployPath,
              title: inferDeploymentTitle(textContent) ?? "Workspace Preview",
              ...(outputKey ? { outputKey } : {})
            };
            const callId = `call_auto_deploy_${Date.now()}`;
            yield {
              type: "tool.call",
              conversationId,
              timestamp: Date.now(),
              messageId: "",
              callId,
              toolName: "deploy_workspace",
              args
            };

            const result = await toolRegistry.execute(
              "deploy_workspace",
              args,
              ctx,
              { callId, source: "system" },
            );
            yield {
              type: "tool.result",
              conversationId,
              timestamp: Date.now(),
              messageId: "",
              callId,
              result: result.ok ? result.value : result.error,
              isError: !result.ok
            };

            if (result.ok && isDeployStatusRecord(result.value)) {
              deployToolSucceededInRun = result.value.status === "ready";
              if (typeof result.value.outputKey === "string") {
                recordTaskArtifact(input.runId, result.value.outputKey, result.value.artifactId);
              }
              yield {
                type: "deploy.status",
                conversationId,
                timestamp: Date.now(),
                messageId: "",
                deployment: result.value
              };
              const loaded = getArtifact(result.value.artifactId);
              if (loaded) {
                yield {
                  type: "artifact.create",
                  conversationId,
                  timestamp: Date.now(),
                  artifact: loaded
                };
              }
              partIndex++;
            }
          }
        }
        if (shouldFinalizeTaskReport(input, Boolean(getTaskReport(input.runId)))) {
          if (textContent) {
            currentMessages = [
              ...currentMessages,
              { role: "assistant", content: textContent }
            ];
          }
          finalizationMode = true;
          continue;
        }
        break;
      }

      // Execute tool calls
      const toolResults: Array<{ callId: string; name: string; result: unknown; isError: boolean }> = [];
      const serializedToolArguments = new Map<string, string>();
      const ctx = buildToolContext(input, signal);

      for (const [, tc] of toolCalls) {
        const injectedArguments = toolArgumentFaultInterceptor?.({
          runId: input.runId,
          toolName: tc.name,
          rawArguments: tc.args,
        });
        const rawArguments = injectedArguments ?? tc.args;
        const parsedArgs = parseToolCallArguments(rawArguments, finishReason, tc.name);
        const args = parsedArgs.ok
          ? parsedArgs.args
          : { rawArguments };
        serializedToolArguments.set(tc.id, parsedArgs.serialized);

        yield {
          type: "tool.call",
          conversationId,
          timestamp: Date.now(),
          messageId: "",
          callId: tc.id,
          toolName: tc.name,
          args,
          argumentRepair: parsedArgs.ok ? parsedArgs.repair : undefined
        };

        const result = parsedArgs.ok
          ? await toolRegistry.execute(
              tc.name,
              args,
              ctx,
              { callId: tc.id, source: "llm" },
            )
          : await toolRegistry.recordPreflightFailure(
              tc.name,
              args,
              parsedArgs.error,
              ctx,
              { callId: tc.id, source: "llm" },
            );
        if (tc.name === "report_task_result" && result.ok) {
          reportToolSucceededInRun = true;
        }

        yield {
          type: "tool.result",
          conversationId,
          timestamp: Date.now(),
          messageId: "",
          callId: tc.id,
          result: result.ok ? result.value : result.error,
          isError: !result.ok
        };

        toolResults.push({
          callId: tc.id,
          name: tc.name,
          result: result.ok ? result.value : result.error,
          isError: !result.ok
        });

        // If tool created an artifact, emit artifact.create with the complete DB row
        if (result.ok && typeof result.value === "object" && result.value !== null) {
          const val = result.value as Record<string, unknown>;
          if (isDeployStatusRecord(result.value)) {
            deployToolSucceededInRun = result.value.status === "ready";
            yield {
              type: "deploy.status",
              conversationId,
              timestamp: Date.now(),
              messageId: "",
              deployment: result.value
            };
          }
          if (typeof val.artifactId === "string") {
            if (
              (tc.name === "write_artifact" || tc.name === "deploy_workspace" || tc.name === "deploy_artifact") &&
              typeof val.outputKey === "string"
            ) {
              recordTaskArtifact(input.runId, val.outputKey, val.artifactId);
            }
            const loaded = getArtifact(val.artifactId as string);
            if (loaded) {
              yield {
                type: "artifact.create",
                conversationId,
                timestamp: Date.now(),
                artifact: loaded
              };
            }
          }
        }
      }

      // Add assistant message + tool results to conversation
      const assistantMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
        role: "assistant",
        content: textContent || null,
        tool_calls: Array.from(toolCalls.entries()).map(([, tc]) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: serializedToolArguments.get(tc.id) ?? "{}"
          }
        }))
      };

      const toolMsgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = toolResults.map((tr) => ({
        role: "tool",
        tool_call_id: tr.callId,
        content: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result)
      }));

      currentMessages = [...currentMessages, assistantMsg, ...toolMsgs];
      partIndex++;
      if (reportToolSucceededInRun || getTaskReport(input.runId)) {
        break;
      }
      if (isFinalizationRound) {
        exhaustedToolRounds = true;
        break;
      }
    }

    if (exhaustedToolRounds && !signal.aborted) {
      const message =
        `⚠️ 工具调用轮次已达到上限（${CUSTOM_AGENT_MAX_TOOL_ROUNDS} 轮）。` +
        "本次运行已停止，避免无限循环。请让 Agent 基于当前错误继续修复，或缩小任务范围后重试。";
      yield {
        type: "part.start",
        conversationId,
        timestamp: Date.now(),
        messageId: "",
        partIndex,
        part: { type: "text", content: "" }
      };
      yield {
        type: "part.delta",
        conversationId,
        timestamp: Date.now(),
        messageId: "",
        partIndex,
        delta: { type: "text.append", text: message }
      };
      yield { type: "part.end", conversationId, timestamp: Date.now(), messageId: "", partIndex };
      throw new Error(`Tool round limit reached (${CUSTOM_AGENT_MAX_TOOL_ROUNDS}).`);
    }

    // Yield final usage
    yield {
      type: "run.usage",
      conversationId,
      timestamp: Date.now(),
      runId: "",
      usage: {
        modelId: model,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens
      }
    };
  }
};

export function buildChatCompletionTools(
  input: AdapterInput
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  if (input.toolNames.length === 0) return [];

  const allowedWorkerIds = input.conversation.agentIds.filter(
    (agentId) => agentId !== input.agent.id
  );

  return toolRegistry.resolve(input.toolNames).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.name === "plan_tasks" && input.agent.isConductor
        ? constrainPlanTaskAgentIds(tool.parameters, allowedWorkerIds)
        : tool.parameters
    }
  }));
}

function buildToolContext(input: AdapterInput, signal: AbortSignal): ToolContext {
  return {
    conversationId: input.conversationId,
    workspacePath: input.workspace.mode === "local" && input.workspace.boundPath
      ? input.workspace.boundPath
      : input.workspace.rootPath,
    agentId: input.agent.id,
    runId: input.runId,
    parentRunId: input.parentRunId ?? null,
    taskExecution: input.taskExecution ?? null,
    taskContract: input.taskContract ?? null,
    abortSignal: signal
  };
}

function inferSingleWebAppOutputKey(taskContract: AdapterInput["taskContract"]): string | undefined {
  const webAppOutputs = (taskContract?.expectedOutputs ?? []).filter((output) => output.type === "web_app");
  if (webAppOutputs.length === 1) return webAppOutputs[0].outputKey;
  const requiredWebAppOutputs = webAppOutputs.filter((output) => output.required !== false);
  return requiredWebAppOutputs.length === 1 ? requiredWebAppOutputs[0].outputKey : undefined;
}

export function shouldAutoDeployWorkspaceFromText(
  text: string,
  toolNames: string[],
  deployToolSucceededInRun: boolean
): boolean {
  return shouldAutoDeployWorkspace(text, toolNames, deployToolSucceededInRun, null, null) &&
    looksLikeDeploymentSuccessClaim(text);
}

export function shouldAutoDeployWorkspace(
  text: string,
  toolNames: string[],
  deployToolSucceededInRun: boolean,
  taskContract: AdapterInput["taskContract"],
  deployablePath: string | null
): boolean {
  return (
    !deployToolSucceededInRun &&
    toolNames.includes("deploy_workspace") &&
    (looksLikeDeploymentSuccessClaim(text) || (!!deployablePath && expectsWebAppOutput(taskContract)))
  );
}

function expectsWebAppOutput(taskContract: AdapterInput["taskContract"]): boolean {
  return (taskContract?.expectedOutputs ?? []).some((output) => output.type === "web_app");
}

export function findDeployableWorkspacePath(workspacePath: string): string | null {
  const buildOutputs = [
    "dist",
    "build",
    "out",
    "client/dist",
    "client/build",
    "client/out",
    "apps/web/dist",
    "apps/web/build",
    "apps/web/out"
  ];

  for (const candidate of buildOutputs) {
    if (hasIndexHtml(path.join(workspacePath, candidate))) {
      return normalizeRelativePath(candidate);
    }
  }

  const rootHasPackageJson = hasFile(path.join(workspacePath, "package.json"));
  const staticCandidates = rootHasPackageJson
    ? []
    : ["public", "todo-app", "app", "workspace"];

  for (const candidate of staticCandidates) {
    if (hasIndexHtml(path.join(workspacePath, candidate))) {
      return normalizeRelativePath(candidate);
    }
  }

  if (hasIndexHtml(workspacePath)) return ".";

  const queue: Array<{ absolutePath: string; depth: number }> = [
    { absolutePath: workspacePath, depth: 0 }
  ];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > 3) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipDeploySearchDir(entry.name)) continue;
      const child = path.join(current.absolutePath, entry.name);
      if (entry.name === "public" && hasFile(path.join(current.absolutePath, "package.json"))) {
        continue;
      }
      if (hasIndexHtml(child)) {
        return normalizeRelativePath(path.relative(workspacePath, child));
      }
      queue.push({ absolutePath: child, depth: current.depth + 1 });
    }
  }

  return null;
}

export function isDeployStatusRecord(value: unknown): value is DeployStatusRecord {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    value.id.startsWith("dep_") &&
    typeof value.artifactId === "string" &&
    typeof value.title === "string" &&
    typeof value.version === "number" &&
    typeof value.previewPath === "string" &&
    typeof value.createdAt === "number" &&
    (value.status === "ready" || value.status === "failed")
  );
}

function looksLikeDeploymentSuccessClaim(text: string): boolean {
  if (!text) return false;

  const hasDeploymentMarker =
    /\/deployments\/dep_[a-zA-Z0-9_-]+/.test(text) ||
    /\[部署预览[:：]/.test(text) ||
    /\[产物[:：].*\bart_[a-zA-Z0-9_-]+\b/.test(text);
  const claimsSuccess =
    /部署成功|重新部署成功|已可预览|应用已可预览|应用已就绪|最新预览地址|部署完成/.test(text);

  return hasDeploymentMarker && claimsSuccess;
}

function inferDeploymentTitle(text: string): string | null {
  const bracketTitle = text.match(/\[部署预览[:：]\s*([^(]+?)\s*\(/)?.[1]?.trim();
  if (bracketTitle) return bracketTitle;

  const title = text.match(/(?:应用|项目)[:：]\s*([^\n]+)/)?.[1]?.trim();
  return title || null;
}

function hasIndexHtml(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory() && fs.statSync(path.join(dir, "index.html")).isFile();
  } catch {
    return false;
  }
}

function hasFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function shouldSkipDeploySearchDir(name: string): boolean {
  return (
    name === "node_modules" ||
    name === ".git" ||
    name === ".next" ||
    name === "deployments" ||
    name.startsWith(".")
  );
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll(path.sep, "/") || ".";
}

type ParsedToolCallArguments =
  | {
      ok: true;
      args: Record<string, unknown>;
      serialized: string;
      repair: { applied: boolean; kinds: string[] };
    }
  | { ok: false; error: string; serialized: string };

export function parseToolCallArguments(
  rawArguments: string,
  finishReason: string | null = null,
  toolName?: string
): ParsedToolCallArguments {
  const repairKinds: string[] = [];
  const trimmed = rawArguments.trim();
  const stripped = stripJsonFence(trimmed);
  if (stripped !== trimmed) repairKinds.push("json_fence_removed");
  let candidate = repairJson(stripped);
  if (candidate !== stripped) repairKinds.push("syntax_repaired");
  const repair = () => ({
    applied: repairKinds.length > 0,
    kinds: [...new Set(repairKinds)],
  });
  if (!candidate) {
    return { ok: true, args: {}, serialized: "{}", repair: repair() };
  }

  for (let depth = 0; depth < 4; depth++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      const concatenated = parseConcatenatedJsonObjects(candidate);
      if (concatenated) {
        repairKinds.push("concatenated_objects_resolved");
        parsed = concatenated[concatenated.length - 1];
      } else {
        const minimalReport = toolName === "report_task_result"
          ? parseMinimalTaskReport(candidate)
          : null;
        if (minimalReport) {
          repairKinds.push("minimal_task_report_recovered");
          return {
            ok: true,
            args: minimalReport,
            serialized: JSON.stringify(minimalReport),
            repair: repair(),
          };
        }
        const detail = error instanceof Error ? error.message : "Unknown JSON parse error";
        const truncationHint = finishReason === "length"
          ? " The model reached its output limit while generating tool arguments. Retry with a shorter artifact, or split it into multiple artifacts."
          : "";
        return {
          ok: false,
          error: `Tool arguments JSON could not be parsed: ${detail}.${truncationHint} Raw arguments: ${previewRawArguments(rawArguments)}`,
          serialized: "{}"
        };
      }
    }

    if (typeof parsed === "string") {
      repairKinds.push("json_string_unwrapped");
      const nestedStripped = stripJsonFence(parsed.trim());
      const nestedRepaired = repairJson(nestedStripped);
      if (nestedRepaired !== nestedStripped) repairKinds.push("syntax_repaired");
      candidate = nestedRepaired;
      continue;
    }

    if (!isRecord(parsed)) {
      return {
        ok: false,
        error: `Tool arguments must be a JSON object, received ${Array.isArray(parsed) ? "array" : typeof parsed}.`,
        serialized: "{}"
      };
    }

    const wrapped = unwrapToolArguments(parsed);
    if (wrapped !== parsed) {
      repairKinds.push("arguments_wrapper_removed");
      if (typeof wrapped === "string") {
        const wrappedStripped = stripJsonFence(wrapped.trim());
        const wrappedRepaired = repairJson(wrappedStripped);
        if (wrappedRepaired !== wrappedStripped) repairKinds.push("syntax_repaired");
        candidate = wrappedRepaired;
        continue;
      }
      if (isRecord(wrapped)) {
        return {
          ok: true,
          args: wrapped,
          serialized: JSON.stringify(wrapped),
          repair: repair(),
        };
      }
    }

    return {
      ok: true,
      args: parsed,
      serialized: JSON.stringify(parsed),
      repair: repair(),
    };
  }

  return {
    ok: false,
    error: "Tool arguments contain too many nested JSON string wrappers.",
    serialized: "{}"
  };
}

function parseMinimalTaskReport(value: string): Record<string, unknown> | null {
  const status = extractJsonStringProperty(value, "status");
  const summary = extractJsonStringProperty(value, "summary");
  if (!summary) return null;
  if (status !== "complete" && status !== "failed" && status !== "blocked") return null;
  return { status, summary };
}

function extractJsonStringProperty(value: string, key: string): string | null {
  const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "s");
  const match = value.match(pattern);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1].replace(/\\n/g, "\n").replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
}

export function mergeToolArgumentChunk(existing: string, incoming: string) {
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (incoming === existing) return existing;
  if (incoming.startsWith(existing)) return incoming;
  if (existing.startsWith(incoming)) return existing;
  return existing + incoming;
}

function parseConcatenatedJsonObjects(value: string): Record<string, unknown>[] | null {
  const documents = splitConcatenatedJsonDocuments(value);
  if (!documents || documents.length < 2) return null;

  const parsed: Record<string, unknown>[] = [];
  for (const document of documents) {
    try {
      const value = JSON.parse(document) as unknown;
      if (!isRecord(value)) return null;
      parsed.push(value);
    } catch {
      return null;
    }
  }
  return parsed;
}

function splitConcatenatedJsonDocuments(value: string): string[] | null {
  const documents: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];

    if (start < 0) {
      if (/\s/.test(char)) continue;
      if (char !== "{") return null;
      start = index;
      depth = 1;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        documents.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return start < 0 && !inString && documents.length > 0 ? documents : null;
}

function unwrapToolArguments(value: Record<string, unknown>): unknown {
  const keys = Object.keys(value);
  if (keys.length !== 1) return value;
  const wrapperKey = keys[0];
  return wrapperKey === "arguments" || wrapperKey === "args" || wrapperKey === "input"
    ? value[wrapperKey]
    : value;
}

function stripJsonFence(value: string): string {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : value;
}

/** Fix common DeepSeek JSON errors: missing braces around nested object keys */
function repairJson(value: string): string {
  // Pattern 1: `[key":` or `,key":` → missing object braces around array items.
  let repaired = repairBareArrayObjectKeys(value);

  // Pattern 2: `"key": word":` → missing `{` before nested object value
  // Example: "content": format": → "content": {"format":
  repaired = repaired.replace(/":\s*([a-zA-Z_]\w*"\s*:)/g, `": {"$1`);
  repaired = escapeControlCharsInJsonStrings(repaired);

  return closeMissingObjectBraces(repaired);
}

function escapeControlCharsInJsonStrings(value: string): string {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];

    if (!inString) {
      repaired += char;
      if (char === "\"") {
        inString = true;
      }
      continue;
    }

    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      repaired += char;
      escaped = true;
      continue;
    }

    if (char === "\"") {
      repaired += char;
      inString = false;
      continue;
    }

    if (char === "\n") {
      repaired += "\\n";
      continue;
    }

    if (char === "\r") {
      repaired += "\\r";
      continue;
    }

    if (char === "\t") {
      repaired += "\\t";
      continue;
    }

    if (char < " ") {
      repaired += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }

    repaired += char;
  }

  return repaired;
}

function repairBareArrayObjectKeys(value: string): string {
  let repaired = "";
  let inString = false;
  let escaped = false;
  const stack: Array<{ type: "array" | "object"; virtual?: boolean }> = [];

  for (let index = 0; index < value.length; index++) {
    const char = value[index];

    if (inString) {
      repaired += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      repaired += char;
      continue;
    }

    if (char === "[") {
      repaired += char;
      stack.push({ type: "array" });
      const match = readBareJsonKey(value, index + 1);
      if (match) {
        repaired += `${value.slice(index + 1, match.start)}{"${match.key}${match.suffix}`;
        stack.push({ type: "object", virtual: true });
        index = match.end - 1;
      }
      continue;
    }

    if (char === ",") {
      const match = readBareJsonKey(value, index + 1);
      if (match) {
        const top = stack[stack.length - 1];
        if (top?.type === "object" && top.virtual) {
          repaired += "}";
          stack.pop();
        }

        const current = stack[stack.length - 1];
        if (current?.type === "array") {
          repaired += `${char}${value.slice(index + 1, match.start)}{"${match.key}${match.suffix}`;
          stack.push({ type: "object", virtual: true });
          index = match.end - 1;
          continue;
        }
      }

      repaired += char;
      continue;
    }

    if (char === "]") {
      while (stack[stack.length - 1]?.type === "object" && stack[stack.length - 1]?.virtual) {
        repaired += "}";
        stack.pop();
      }
      repaired += char;
      if (stack[stack.length - 1]?.type === "array") {
        stack.pop();
      }
      continue;
    }

    if (char === "{") {
      stack.push({ type: "object" });
      repaired += char;
      continue;
    }

    if (char === "}") {
      repaired += char;
      if (stack[stack.length - 1]?.type === "object") {
        stack.pop();
      }
      continue;
    }

    repaired += char;
  }

  return repaired;
}

function readBareJsonKey(value: string, offset: number): { start: number; end: number; key: string; suffix: string } | null {
  let start = offset;
  while (/\s/.test(value[start] ?? "")) start++;
  if (!/[A-Za-z_]/.test(value[start] ?? "")) return null;

  let cursor = start + 1;
  while (/[A-Za-z0-9_]/.test(value[cursor] ?? "")) cursor++;
  if (value[cursor] !== "\"") return null;

  let colon = cursor + 1;
  while (/\s/.test(value[colon] ?? "")) colon++;
  if (value[colon] !== ":") return null;

  return {
    start,
    end: colon + 1,
    key: value.slice(start, cursor),
    suffix: value.slice(cursor, colon + 1)
  };
}

function closeMissingObjectBraces(value: string): string {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const char of value) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
    }
  }

  if (inString || escaped || depth <= 0) return value;
  return `${value}${"}".repeat(depth)}`;
}

function previewRawArguments(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return JSON.stringify(compact.length > 180 ? `${compact.slice(0, 177)}...` : compact);
}

function constrainPlanTaskAgentIds(
  parameters: Record<string, unknown>,
  allowedAgentIds: string[]
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>;
  const properties = asRecord(cloned.properties);
  const tasks = asRecord(properties?.tasks);
  const items = asRecord(tasks?.items);
  const itemProperties = asRecord(items?.properties);
  const agentId = asRecord(itemProperties?.agentId);
  if (!agentId) return cloned;

  agentId.enum = allowedAgentIds;
  agentId.description =
    `Exact worker agent ID. Must be one of: ${allowedAgentIds.join(", ") || "(none)"}.`;
  return cloned;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildMessages(input: AdapterInput): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  const runtimePlatform = buildRuntimePlatformPrompt(input.workspacePath);

  // P0: When dynamic context XML is provided, use stable prefix + dynamic suffix layout
  if (input.contextXml) {
    const triggerText = input.triggerMessage.parts
      .filter((p) => p.type === "text")
      .map((p) => p.content)
      .join("\n");

    const layout = buildPromptLayout({
      agentId: input.agent.id,
      agentName: input.agent.name,
      agentSystemPrompt: input.agent.systemPrompt,
      agentCapabilities: input.agent.capabilities,
      toolNames: input.toolNames,
      roleContractVersion: "role-contracts-v1",
      platformPromptVersion: "agentmeld-p0-v1",
      stableSections: [
        { id: "workspace_info", title: "Workspace", content: `<workspace_info>\n  <cwd>${input.workspacePath}</cwd>\n  <mode>sandbox</mode>\n</workspace_info>`, tokenEstimate: 30 },
        { id: "runtime_platform", title: "Runtime Platform", content: runtimePlatform, tokenEstimate: 120 },
        { id: "tool_guidance", title: "Tool Guidance", content: extractToolGuidance(input.systemPrompt), tokenEstimate: 200 },
      ],
      userMessage: triggerText,
      taskPrompt: input.taskExecution ? "Dispatched sub-task — see context below." : triggerText,
      taskContextXml: input.contextXml,
      failureContextXml: "",
    });

    messages.push({ role: "system", content: layout.stablePrefix });

    // Cross-run history
    if (input.history && input.history.length > 0) {
      for (const h of input.history) {
        messages.push({ role: h.role as "user" | "assistant" | "system", content: h.content });
      }
    }

    messages.push({ role: "user", content: layout.dynamicSuffix });
    return messages;
  }

  // Legacy path: no contextXml, use original behavior
  messages.push({ role: "system", content: `${input.systemPrompt}\n\n${runtimePlatform}` });

  if (input.history && input.history.length > 0) {
    for (const h of input.history) {
      messages.push({ role: h.role as "user" | "assistant" | "system", content: h.content });
    }
  }

  const triggerText = input.triggerMessage.parts
    .filter((p) => p.type === "text")
    .map((p) => p.content)
    .join("\n");
  messages.push({ role: "user", content: triggerText });

  return messages;
}

function buildRuntimePlatformPrompt(workspacePath: string): string {
  const isWindows = process.platform === "win32";
  if (isWindows) {
    return [
      "<runtime_platform>",
      "  <os>windows</os>",
      "  <shell>PowerShell</shell>",
      `  <workspace_path>${escapePromptXml(workspacePath)}</workspace_path>`,
      "  <command_rules>",
      "    Use the real workspace_path above as the current project directory; do not use /workspace.",
      "    Use PowerShell-compatible command separators. Prefer: cd \"<workspace_path>\"; npm run build",
      "    Do not use POSIX-only syntax such as &&, cp, mv, rm -rf, sed, cat > file, grep, chmod, or /tmp paths.",
      "    Do not create directories or modify source files with shell commands. Use fs_mkdir for directories, fs_patch for focused edits, and fs_write for new files or intentional full replacement.",
      "    bash is only for verification commands and dependency install/update commands that may require user approval.",
      "    AgentMeld-managed workspaces are nested under the host project. Never run pnpm install/add/remove/update/ci there because it can mutate the host node_modules. Use npm install or npm ci for generated projects.",
      "  </command_rules>",
      "</runtime_platform>",
    ].join("\n");
  }

  return [
    "<runtime_platform>",
    "  <os>posix</os>",
    "  <shell>sh-compatible</shell>",
    `  <workspace_path>${escapePromptXml(workspacePath)}</workspace_path>`,
    "  <command_rules>",
    "    Use the real workspace_path above as the current project directory.",
    "    POSIX command separators like && are allowed for verification commands.",
      "    Do not create directories or modify source files with shell commands. Use fs_mkdir for directories, fs_patch for focused edits, and fs_write for new files or intentional full replacement.",
      "    bash is only for verification commands and dependency install/update commands that may require user approval.",
      "    AgentMeld-managed workspaces may be nested under the host project. Never run pnpm install/add/remove/update/ci there; use npm install or npm ci for generated projects.",
    "  </command_rules>",
    "</runtime_platform>",
  ].join("\n");
}

function escapePromptXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Extract only the tool guidance section from the full system prompt. */
function extractToolGuidance(systemPrompt: string): string {
  const idx = systemPrompt.indexOf("## AgentMeld 工具调用规范");
  if (idx < 0) return "";
  // Find next "## " or end of string
  const endIdx = systemPrompt.indexOf("\n## ", idx + 5);
  return endIdx > idx ? systemPrompt.slice(idx, endIdx).trim() : systemPrompt.slice(idx).trim();
}

function formatApiError(err: unknown, model: string): string {
  if (err instanceof Error) {
    const msg = err.message;
    // OpenAI SDK wraps HTTP errors with status code in message
    if (msg.includes("401")) {
      return `⚠️ API Key 无效（401）。请在 Settings → DeepSeek API Key 中检查 Key 是否正确，或确认 Key 是否已过期。`;
    }
    if (msg.includes("403")) {
      return `⚠️ 访问被拒绝（403）。API Key 可能没有权限访问模型 "${model}"，或账户余额不足。请检查 DeepSeek 控制台。`;
    }
    if (msg.includes("429")) {
      return `⚠️ API 请求频率过高（429）。DeepSeek 限流，请稍后重试。`;
    }
    if (msg.includes("500") || msg.includes("502") || msg.includes("503")) {
      return `⚠️ DeepSeek 服务端错误（5xx）。服务器暂时不可用，请稍后重试。`;
    }
    if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("ECONNREFUSED")) {
      return `⚠️ 连接 DeepSeek API 超时。请检查网络连接，或确认 API Base URL 配置正确。`;
    }
    return `⚠️ API 调用失败：${msg.slice(0, 200)}`;
  }
  return `⚠️ API 调用失败：未知错误。`;
}
