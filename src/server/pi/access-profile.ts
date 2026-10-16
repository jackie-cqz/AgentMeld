import { PiRuntimeError } from "./process";

export type PiAccessMode = "workspace" | "conversation";

/** No native filesystem, shell, URL fetch, facts mutation, planning or approval tools. */
export const CONVERSATION_TOOL_NAMES: readonly string[] = ["list_team_members", "read_artifact", "consult_agent", "respond_to_consultation"];

export function assertPiAccessProfile(mode: PiAccessMode | undefined, toolNames: readonly string[]): void {
  if (mode !== "conversation") return;
  const forbidden = toolNames.filter(name => !CONVERSATION_TOOL_NAMES.includes(name));
  if (forbidden.length) {
    throw new PiRuntimeError(`Conversation-only invocation cannot access: ${forbidden.join(", ")}`, "security_policy");
  }
}
