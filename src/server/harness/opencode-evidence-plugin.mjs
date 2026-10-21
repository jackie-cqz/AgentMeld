/**
 * OpenCode's native-tool admission hook for one AgentMeld invocation.
 *
 * OpenCode keeps its own file/shell toolset. The platform must still admit,
 * approve and hash those calls the way it does for Pi, and OpenCode 1.19.3
 * exposes exactly one pre-execution seam: the plugin `tool.execute.before`
 * hook, which runs inside the OpenCode process before the tool's own execute
 * (verified against the pinned build). This plugin maps OpenCode's native tool
 * names onto the platform's native family and forwards the call to the
 * platform's invocation-scoped loopback endpoint. The endpoint owns admission,
 * approvals, quota and the expected post-write hash; this file only transports.
 *
 * Outcomes are completed by the driver from OpenCode's event stream, which also
 * reports refused/failed calls the `tool.execute.after` hook never sees.
 *
 * The bridge token is inherited from the OpenCode server environment. It is
 * per-invocation and revoked at teardown; native `bash` inherits it too, which
 * is the same exposure the resolved provider credential already has through
 * `OPENCODE_CONFIG_CONTENT`.
 */
import fs from "node:fs";

const BRIDGE_URL = process.env.AGENTMELD_OPENCODE_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.AGENTMELD_OPENCODE_BRIDGE_TOKEN;

/** OpenCode native tool -> platform native name. */
const NATIVE_TO_PLATFORM = {
  read: "fs_read",
  write: "fs_write",
  edit: "fs_patch",
  bash: "bash",
  grep: "fs_search",
  glob: "fs_glob",
  list: "fs_list",
};

async function post(operation, body) {
  const response = await fetch(`${BRIDGE_URL}${operation}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${BRIDGE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || (payload && payload.ok === false)) {
    throw new Error(payload && typeof payload.error === "string"
      ? payload.error
      : "AgentMeld refused the native tool call.");
  }
}

function targetPath(platform, args) {
  if (platform === "fs_read" || platform === "fs_write" || platform === "fs_patch") {
    return typeof args.filePath === "string" ? args.filePath : null;
  }
  if (platform === "fs_search" || platform === "fs_glob" || platform === "fs_list") {
    return typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
  }
  return null;
}

/**
 * The bytes a write/edit is about to produce, so the platform can approve and
 * hash them *before* OpenCode mutates the file.
 */
function proposedChange(platform, args) {
  if (platform === "fs_write") {
    if (typeof args.filePath !== "string" || typeof args.content !== "string") {
      throw new Error("fs_write requires an absolute filePath and string content.");
    }
    return { path: args.filePath, content: args.content };
  }
  if (platform !== "fs_patch") return null;
  if (typeof args.filePath !== "string" || typeof args.oldString !== "string" || typeof args.newString !== "string") {
    throw new Error("fs_patch requires filePath, oldString and newString.");
  }
  if (args.oldString.length === 0) throw new Error("oldString must not be empty.");
  let current;
  try {
    current = fs.readFileSync(args.filePath, "utf8");
  } catch {
    throw new Error(`Cannot edit ${args.filePath}: the file is not readable.`);
  }
  const matches = current.split(args.oldString).length - 1;
  if (matches === 0) throw new Error(`oldString was not found in ${args.filePath}.`);
  if (matches > 1 && args.replaceAll !== true) {
    throw new Error(`Found ${matches} matches for oldString in ${args.filePath}; provide more surrounding context or set replaceAll.`);
  }
  const content = args.replaceAll === true
    ? current.split(args.oldString).join(args.newString)
    : (() => {
        const at = current.indexOf(args.oldString);
        return current.slice(0, at) + args.newString + current.slice(at + args.oldString.length);
      })();
  return { path: args.filePath, content };
}

export const AgentMeldEvidence = async () => {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) throw new Error("AgentMeld OpenCode bridge is not configured.");
  await post("/ready", { kind: "plugin" });
  return {
    "tool.execute.before": async (input, output) => {
      const platform = NATIVE_TO_PLATFORM[input?.tool];
      if (!platform) return;
      const args = output && output.args && typeof output.args === "object" ? output.args : {};
      const body = {
        callId: String(input.callID),
        name: platform,
        args,
        targetPath: targetPath(platform, args),
        change: proposedChange(platform, args),
      };
      if (platform === "bash") {
        if (typeof args.command !== "string") throw new Error("bash requires a command.");
        body.command = args.command;
        if (typeof args.timeout === "number") body.timeoutMs = args.timeout;
      }
      await post("/native/authorize", body);
    },
  };
};

export default AgentMeldEvidence;
