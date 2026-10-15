import {
  createReadTool, createWriteTool, createEditTool, createBashTool,
  createGrepTool, createFindTool, createLsTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs/promises";
import path from "node:path";

// This extension is the only extension loaded by the platform-owned Pi process.
export default async function agentMeldExtension(pi) {
  const url = process.env.AGENTMELD_PI_BRIDGE_URL;
  const token = process.env.AGENTMELD_PI_BRIDGE_TOKEN;
  if (!url || !token) throw new Error("AgentMeld Pi bridge is not configured.");
  const call = async (operation, body, signal) => {
    const response = await fetch(`${url}${operation}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal,
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.error ?? "AgentMeld rejected the operation.");
    return result;
  };
  const manifest = await call("/manifest");
  const cwd = process.cwd();
  const writeOperation = (callId, signal) => async (absolutePath, content) => {
    await call("/native/change", { callId, path: absolutePath, content }, signal);
    signal?.throwIfAborted();
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    signal?.throwIfAborted();
    await fs.writeFile(absolutePath, content, "utf8");
  };
  const tools = {
    read: () => createReadTool(cwd),
    write: (callId, signal) => createWriteTool(cwd, { operations: {
      // Directory creation is deferred until the change itself has been approved.
      writeFile: writeOperation(callId, signal), mkdir: async () => {},
    } }),
    edit: (callId, signal) => createEditTool(cwd, { operations: {
      access: async absolutePath => { await fs.access(absolutePath); }, readFile: absolutePath => fs.readFile(absolutePath),
      writeFile: writeOperation(callId, signal),
    } }),
    grep: () => createGrepTool(cwd), find: () => createFindTool(cwd), ls: () => createLsTool(cwd),
    bash: () => createBashTool(cwd, { exposeSessionEnvironment: false, spawnHook: context => {
      const env = { ...context.env };
      for (const key of Object.keys(env)) if (key.startsWith("AGENTMELD_PI_")) delete env[key];
      return { ...context, env };
    } }),
  };
  for (const name of manifest.native) {
    const native = tools[name]?.();
    if (!native) throw new Error(`Unsupported Pi native tool: ${name}`);
    pi.registerTool({ ...native, executionMode: "sequential", async execute(callId, args, signal, update, ctx) {
      await call("/native/authorize", { callId, name, args }, signal);
      let result;
      try { result = await tools[name](callId, signal).execute(callId, args, signal, update, ctx); }
      catch (error) {
        await call("/native/result", { callId, isError: true, result: { content: [{ type: "text", text: error instanceof Error ? error.message : "Native tool failed." }] } }, signal);
        throw error;
      }
      await call("/native/result", { callId, result, isError: false }, signal);
      return result;
    } });
  }
  for (const definition of manifest.definitions) {
    pi.registerTool({ name: definition.name, label: definition.name, description: definition.description,
      parameters: Type.Unsafe(definition.parameters), executionMode: "sequential",
      async execute(callId, args, signal) {
        const result = await call("/tool", { callId, name: definition.name, args }, signal);
        return { content: [{ type: "text", text: JSON.stringify(result.value) }], details: { agentmeld: result },
          terminate: definition.name === "plan_tasks" || definition.name === "report_task_result" };
      },
    });
  }
  pi.on("before_agent_start", () => ({ systemPrompt: `${manifest.systemPrompt}\n\n${
    manifest.needsReport ? "When the assigned task is finished or cannot proceed, call report_task_result with actual evidence. Never claim completion without submitting that result." : ""
  }\nUse Pi native read/write/edit/ls/grep/find for filesystem operations and bash for approved verification. Native schemas override legacy filesystem examples: edit uses {path,edits:[{oldText,newText}]}, read uses offset/limit, grep uses pattern; replaceAll and nextStartColumn are not native arguments. The runtime owns history and compaction. Commands execute in Bash, including on Windows. Do not modify source with shell commands.` }));
  pi.on("turn_start", async (_event, ctx) => {
    try { await call("/turn", {}); }
    catch (error) { ctx.abort(); throw error; }
  });
  pi.on("tool_call", event => {
    if (![...manifest.native, ...manifest.definitions.map(tool => tool.name)].includes(event.toolName)) {
      return { block: true, reason: "Tool is not authorized by AgentMeld." };
    }
  });
  await call("/ready", {});
}
