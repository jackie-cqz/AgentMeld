import { PI_RETIRED_TOOLS } from "@/shared/agent-constants";
import type { HarnessAccessMode } from "./types";
import { HarnessError } from "./errors";
import { NATIVE_WORKSPACE_TOOLS } from "./native-tools";
import { toolRegistry } from "@/server/tools/registry";

/**
 * Platform protocol tools that are NOT Agent capabilities.
 *
 * `plan_tasks` is how the Conductor's PLAN stage terminates and hands a DAG to
 * the platform; it is provisioned explicitly by that stage. Handing it to every
 * Agent would let any worker end its own tool loop by "planning", so it stays a
 * stage tool rather than becoming a full-access grant. `respond_to_consultation`
 * belongs to the admitted peer invocation only.
 */
const INTERNAL_PROTOCOL_TOOLS: readonly string[] = ["plan_tasks", "respond_to_consultation"];

/**
 * The roster is shared by all current conversation members. It does not expose
 * credentials, prompts, or Agents outside the caller's conversation.
 */
export const CONVERSATION_ROSTER_TOOL = "list_team_members";

/**
 * No native filesystem, shell, URL fetch, facts mutation, planning or approval
 * tools in a context-only invocation. This is a platform access decision, not an
 * engine setting, so it is owned here rather than inside a driver.
 */
export const CONVERSATION_TOOL_NAMES: readonly string[] = ["list_team_members", "read_artifact", "consult_agent", "respond_to_consultation"];

/**
 * Refuse a context-only invocation that was provisioned with workspace tools.
 *
 * A driver calls this before it starts an engine, so an access-mode mistake fails
 * before any process exists. The message names the offending platform tools, not
 * an engine's names.
 */
export function assertHarnessAccessProfile(mode: HarnessAccessMode | undefined, toolNames: readonly string[]): void {
  if (mode !== "conversation") return;
  const forbidden = toolNames.filter(name => !CONVERSATION_TOOL_NAMES.includes(name));
  if (forbidden.length) {
    throw new HarnessError(`Conversation-only invocation cannot access: ${forbidden.join(", ")}`, "security_policy");
  }
}

/**
 * Every platform tool an Agent run is provisioned with (issue #79).
 *
 * AgentMeld no longer keeps a per-Agent capability whitelist: an Agent run always
 * receives the whole workspace toolset and the model decides what to use. The
 * stored `agent.toolNames` grants are kept only as a record — they no longer
 * select or authorize anything, which is also why an old record naming a retired
 * tool can no longer break a run.
 *
 * The retired job_* command kernel stays out. PR #75 removed it from the runtime
 * on purpose, and that is a property of the runtime, not a per-Agent grant:
 * re-admitting it as "full permission" would quietly restore the old command
 * kernel this core replaced. Terminal protocol operations stay scoped to their
 * actual platform phase; they are not workspace capabilities.
 *
 * Names are PLATFORM names (fs_read, …). A driver maps the workspace-native
 * family (`NATIVE_WORKSPACE_TOOLS`) to its own names and registers every other
 * entry as one of its business tools.
 */
const NATIVE_NAMES: ReadonlySet<string> = new Set(NATIVE_WORKSPACE_TOOLS);

export function provisionedPlatformToolNames(): string[] {
  const excluded = [...PI_RETIRED_TOOLS, ...INTERNAL_PROTOCOL_TOOLS];
  return [
    ...NATIVE_WORKSPACE_TOOLS,
    ...toolRegistry.listNames().filter((name) => !NATIVE_NAMES.has(name) && !excluded.includes(name))
  ];
}
