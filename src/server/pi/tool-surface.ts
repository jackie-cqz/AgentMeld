import { PI_RETIRED_TOOLS } from "@/shared/agent-constants";
import { toolRegistry } from "@/server/tools/registry";
import { PI_NATIVE_TO_PLATFORM } from "@/server/pi/native-tools";

/**
 * Platform protocol tools that are NOT Agent capabilities.
 *
 * `plan_tasks` is how the Conductor's PLAN stage terminates and hands a DAG to
 * the platform; it is provisioned explicitly by that stage. Handing it to every
 * Agent would let any worker end its own tool loop by "planning", so it stays a
 * stage tool rather than becoming a full-access grant.
 */
const CONDUCTOR_PROTOCOL_TOOLS: readonly string[] = ["plan_tasks"];

/**
 * Every platform tool an Agent run is provisioned with (issue #79).
 *
 * AgentMeld no longer keeps a per-Agent capability whitelist: a Pi Agent is a
 * native Pi agent, so an Agent run always receives the whole Pi toolset and the
 * model decides what to use. The stored `agent.toolNames` grants are kept only
 * as a record — they no longer select or authorize anything, which is also why
 * an old record naming a retired tool can no longer break a run.
 *
 * The retired job_* command kernel stays out. PR #75 removed it from the Pi
 * runtime on purpose, and that is a property of the runtime, not a per-Agent
 * grant: re-admitting it as "full permission" would quietly restore the old
 * command kernel this core replaced. Conductor stage protocol tools stay out
 * for the same reason (see CONDUCTOR_PROTOCOL_TOOLS).
 *
 * Names are PLATFORM names (fs_read, …). The bridge maps the filesystem family
 * to the Pi native names and registers every other entry as an extension tool.
 */
export function provisionedPlatformToolNames(): string[] {
  const native = Object.values(PI_NATIVE_TO_PLATFORM);
  const excluded = [...PI_RETIRED_TOOLS, ...CONDUCTOR_PROTOCOL_TOOLS];
  return [
    ...native,
    ...toolRegistry.listNames().filter((name) => !native.includes(name) && !excluded.includes(name))
  ];
}
